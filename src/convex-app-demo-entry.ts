/**
 * Entry point for Convex App Demo
 * This file is loaded by the HTML and bootstraps the demo
 */

import { VirtualFS } from './virtual-fs';
import { Runtime } from './runtime';
import { NextDevServer } from './frameworks/next-dev-server';
import { getServerBridge } from './server-bridge';
import { Buffer } from './shims/stream';
import { createConvexAppProject } from './convex-app-demo';
import { PackageManager } from './npm/index';

// DOM elements
const logsEl = document.getElementById('logs') as HTMLDivElement;
const previewContainer = document.getElementById('previewContainer') as HTMLDivElement;
const statusDot = document.getElementById('statusDot') as HTMLSpanElement;
const statusText = document.getElementById('statusText') as HTMLSpanElement;
const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;
const openBtn = document.getElementById('openBtn') as HTMLButtonElement;
const convexKeyInput = document.getElementById('convexKey') as HTMLInputElement;
const deployBtn = document.getElementById('deployBtn') as HTMLButtonElement;

let serverUrl: string | null = null;
let iframe: HTMLIFrameElement | null = null;
let vfs: VirtualFS | null = null;
let convexUrl: string | null = null;
let cliRuntime: Runtime | null = null;
let devServer: NextDevServer | null = null;

// Status codes for test automation
type StatusCode =
  | 'DEPLOYING'
  | 'INSTALLED'
  | 'CLI_RUNNING'
  | 'WAITING'
  | 'COMPLETE'
  | 'ERROR';

function log(message: string, type: 'info' | 'error' | 'warn' | 'success' = 'info') {
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  if (type === 'error') line.className = 'error';
  if (type === 'warn') line.className = 'warn';
  if (type === 'success') line.className = 'success';
  logsEl.appendChild(line);
  logsEl.scrollTop = logsEl.scrollHeight;
}

function logStatus(status: StatusCode, message: string) {
  log(`[STATUS:${status}] ${message}`, status === 'ERROR' ? 'error' : status === 'COMPLETE' ? 'success' : 'info');
}

function setStatus(text: string, state: 'loading' | 'running' | 'error' = 'loading') {
  statusText.textContent = text;
  statusDot.className = 'status-dot ' + state;
}

/**
 * Parse Convex deploy key to extract deployment name and URL
 */
function parseConvexKey(key: string): { deploymentName: string; url: string; adminKey: string } | null {
  // Format: dev:deployment-name|token or prod:deployment-name|token
  const match = key.match(/^(dev|prod):([^|]+)\|(.+)$/);
  if (!match) return null;

  const [, env, deploymentName] = match;
  const url = `https://${deploymentName}.convex.cloud`;
  return { deploymentName, url, adminKey: key };
}

/**
 * Wait for deployment to complete by polling for .env.local creation
 * This replaces the fixed 10s timeout with smart polling
 */
async function waitForDeployment(vfs: VirtualFS, maxWait = 30000, pollInterval = 500): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    if (vfs.existsSync('/project/.env.local')) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  return false;
}

/**
 * Wait for _generated directory to be created (indicates functions were bundled)
 */
async function waitForGenerated(vfs: VirtualFS, maxWait = 15000, pollInterval = 500): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    if (vfs.existsSync('/project/convex/_generated')) {
      const files = vfs.readdirSync('/project/convex/_generated');
      if (files.length > 0) {
        return true;
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  return false;
}

/**
 * Deploy Convex schema and functions to Convex cloud using the Convex CLI
 *
 * This approach is documented in examples/convex-todo/src/hooks/useConvexRuntime.ts
 * Key requirements:
 * 1. Use /project/ as the working directory (CLI expects this structure)
 * 2. Use runtime.execute() with inline code that sets process.env and process.argv
 * 3. Use require() with relative path to the CLI bundle
 * 4. Create both .ts AND .js versions of convex/convex.config
 * 5. Wait for async operations after CLI runs
 */
async function deployToConvex(adminKey: string): Promise<void> {
  if (!vfs) throw new Error('VFS not initialized');

  const parsed = parseConvexKey(adminKey);
  if (!parsed) {
    throw new Error('Invalid deploy key format. Expected: dev:name|token');
  }

  logStatus('DEPLOYING', `Starting deployment to ${parsed.deploymentName}...`);

  // Create /project directory structure for CLI (matching working example)
  log('Setting up project structure for CLI...');
  vfs.mkdirSync('/project', { recursive: true });
  vfs.mkdirSync('/project/convex', { recursive: true });

  // Create package.json in /project (and root - CLI looks for both)
  const packageJson = JSON.stringify({
    name: 'convex-app-demo',
    version: '1.0.0',
    dependencies: { convex: '^1.0.0' }
  }, null, 2);
  vfs.writeFileSync('/project/package.json', packageJson);
  vfs.writeFileSync('/package.json', packageJson);

  // Create convex.json in /project
  vfs.writeFileSync('/project/convex.json', JSON.stringify({
    functions: "convex/"
  }, null, 2));

  // Create convex config files (BOTH .ts and .js required!)
  const convexConfig = `import { defineApp } from "convex/server";
const app = defineApp();
export default app;
`;
  vfs.writeFileSync('/project/convex/convex.config.ts', convexConfig);
  vfs.writeFileSync('/project/convex/convex.config.js', convexConfig);

  // Remove any existing _generated directory - the CLI must create fresh ones
  // This ensures the CLI doesn't skip the push because it sees stale generated files
  const generatedPaths = ['/project/convex/_generated', '/convex/_generated'];
  for (const genPath of generatedPaths) {
    if (vfs.existsSync(genPath)) {
      log(`Removing existing ${genPath} directory...`);
      try {
        const files = vfs.readdirSync(genPath);
        for (const file of files) {
          vfs.unlinkSync(`${genPath}/${file}`);
        }
        vfs.rmdirSync(genPath);
      } catch (e) {
        log(`Warning: Could not remove ${genPath}: ${e}`, 'warn');
      }
    }
  }

  // Copy convex files from root to /project/convex/
  const convexFiles = ['schema.ts', 'todos.ts'];
  for (const file of convexFiles) {
    if (vfs.existsSync(`/convex/${file}`)) {
      const content = vfs.readFileSync(`/convex/${file}`, 'utf8');
      vfs.writeFileSync(`/project/convex/${file}`, content);
      log(`  Copied /convex/${file} to /project/convex/${file}`);
    }
  }

  // Install convex package in /project
  const convexPkgPath = '/project/node_modules/convex/package.json';
  if (!vfs.existsSync(convexPkgPath)) {
    log('Installing convex package...');
    const npm = new PackageManager(vfs, { cwd: '/project' });
    try {
      await npm.install('convex', {
        onProgress: (msg) => log(`  ${msg}`),
      });
      logStatus('INSTALLED', 'Convex package installed');
    } catch (error) {
      logStatus('ERROR', `Failed to install convex: ${error}`);
      throw error;
    }
  } else {
    logStatus('INSTALLED', 'Convex package already installed');
  }

  // Run Convex CLI using runtime.execute() with cwd /project
  // IMPORTANT: Reuse the same Runtime instance to preserve module caching
  // Match working example: just { cwd: '/project' }, no env or onConsole options
  logStatus('CLI_RUNNING', 'Running convex dev --once');

  if (!cliRuntime) {
    cliRuntime = new Runtime(vfs, { cwd: '/project' });
  }

  // Debug: verify files exist before running CLI
  log('Verifying project structure...');
  const requiredFiles = [
    '/project/package.json',
    '/project/convex.json',
    '/project/convex/convex.config.ts',
    '/project/convex/convex.config.js',
    '/project/convex/schema.ts',
    '/project/convex/todos.ts',
    '/project/node_modules/convex/package.json',
    '/project/node_modules/convex/dist/cli.bundle.cjs',
  ];
  for (const file of requiredFiles) {
    if (vfs.existsSync(file)) {
      log(`  ✓ ${file}`, 'success');
    } else {
      log(`  ✗ ${file} MISSING`, 'error');
    }
  }

  // Match working example exactly
  const cliCode = `
    // Set environment for Convex CLI
    process.env.CONVEX_DEPLOY_KEY = '${adminKey}';

    // Set CLI arguments
    process.argv = ['node', 'convex', 'dev', '--once'];

    // Run the CLI
    require('./node_modules/convex/dist/cli.bundle.cjs');
  `;

  try {
    cliRuntime.execute(cliCode, '/project/cli-runner.js');
  } catch (cliError) {
    // Some errors are expected (like process.exit or stack overflow in watcher)
    // The important work (deployment) happens before these errors
    log(`CLI completed with: ${(cliError as Error).message}`, 'warn');
  }

  // Wait for async operations to complete using smart polling
  // Poll for .env.local creation instead of fixed timeout
  logStatus('WAITING', 'Waiting for deployment to complete...');
  const deploymentSucceeded = await waitForDeployment(vfs, 30000, 500);

  if (!deploymentSucceeded) {
    log('Deployment may still be in progress, waiting additional time...', 'warn');
    await new Promise(resolve => setTimeout(resolve, 5000));
  } else {
    // .env.local was found, now wait for _generated directory
    // The CLI creates .env.local first, then bundles functions asynchronously
    log('Environment configured, waiting for function bundling...');
    const generatedCreated = await waitForGenerated(vfs, 15000, 500);
    if (!generatedCreated) {
      log('_generated directory not created yet, waiting additional time...', 'warn');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // Check if deployment succeeded by reading .env.local (CLI creates it in /project)
  const envLocalPath = '/project/.env.local';
  if (vfs.existsSync(envLocalPath)) {
    const envContent = vfs.readFileSync(envLocalPath, 'utf8');
    log('.env.local created - deployment succeeded!', 'success');
    log(`  Contents: ${envContent.trim()}`);

    // Check if _generated directory was created (indicates functions were pushed)
    if (vfs.existsSync('/project/convex/_generated')) {
      const generated = vfs.readdirSync('/project/convex/_generated');
      log(`  Generated files: ${generated.join(', ')}`, 'success');

      // Show the contents of api.js to verify function references
      if (vfs.existsSync('/project/convex/_generated/api.js')) {
        const apiContent = vfs.readFileSync('/project/convex/_generated/api.js', 'utf8');
        log('  Generated api.js content:', 'info');
        // Show first 500 chars
        log(`  ${apiContent.substring(0, 500)}...`, 'info');
      }

      // Copy generated files to /convex/_generated/ for the Next.js app to use
      // CLI generates .js/.d.ts files, but Next.js imports .ts files
      // So we copy api.js as both api.js AND api.ts
      log('Copying generated files to /convex/_generated/...');
      vfs.mkdirSync('/convex/_generated', { recursive: true });
      for (const file of generated) {
        const srcPath = `/project/convex/_generated/${file}`;
        const destPath = `/convex/_generated/${file}`;
        if (vfs.existsSync(srcPath)) {
          const content = vfs.readFileSync(srcPath, 'utf8');
          vfs.writeFileSync(destPath, content);
          log(`  Copied ${file}`, 'success');

          // Also copy .js files as .ts for Next.js imports
          if (file.endsWith('.js') && !file.endsWith('.d.js')) {
            const tsDestPath = destPath.replace(/\.js$/, '.ts');
            vfs.writeFileSync(tsDestPath, content);
            log(`  Also copied as ${file.replace(/\.js$/, '.ts')}`, 'success');
          }
        }
      }
    } else {
      log('  WARNING: _generated directory not created - functions may not be deployed!', 'error');
    }

    // Parse the Convex URL from .env.local
    const match = envContent.match(/CONVEX_URL=(.+)/);
    if (match) {
      convexUrl = match[1].trim();
      logStatus('COMPLETE', `Deployment successful - connected to ${convexUrl}`);
    } else {
      convexUrl = parsed.url;
      logStatus('COMPLETE', `Deployment successful - Convex URL set: ${convexUrl}`);
    }
  } else {
    log('.env.local not found - checking root...', 'warn');
    // Also check root in case CLI wrote there
    if (vfs.existsSync('/.env.local')) {
      const envContent = vfs.readFileSync('/.env.local', 'utf8');
      log(`Found .env.local at root: ${envContent.trim()}`);
      const match = envContent.match(/CONVEX_URL=(.+)/);
      if (match) {
        convexUrl = match[1].trim();
      }
    }
    if (!convexUrl) {
      convexUrl = parsed.url;
      log(`Using fallback URL: ${convexUrl}`, 'warn');
    }
  }

  // Set the env var on the dev server (idiomatic Next.js pattern)
  // This makes it available via process.env.NEXT_PUBLIC_CONVEX_URL in browser code
  if (devServer && convexUrl) {
    devServer.setEnv('NEXT_PUBLIC_CONVEX_URL', convexUrl);
    log(`Set NEXT_PUBLIC_CONVEX_URL=${convexUrl}`);
  }

  // Also set on parent window for backwards compatibility
  (window as any).__CONVEX_URL__ = convexUrl;

  // Wait a moment for things to settle before refreshing
  log('Waiting for iframe refresh...');
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Refresh the iframe to pick up the new Convex connection
  if (iframe) {
    const iframeSrc = iframe.src;
    log(`Refreshing preview: ${iframeSrc}`);

    // Add load handler to track iframe state
    iframe.onload = () => {
      log('Iframe loaded successfully', 'success');
      // The env var is now injected via the HTML, so we only need the fallback
      if (convexUrl && iframe?.contentWindow) {
        (iframe.contentWindow as any).__CONVEX_URL__ = convexUrl;
      }
    };

    iframe.onerror = (e) => {
      log(`Iframe error: ${e}`, 'error');
    };

    // Clear and reload
    iframe.src = 'about:blank';
    await new Promise(resolve => setTimeout(resolve, 500));
    iframe.src = iframeSrc;
    log('Preview refresh initiated', 'success');
  } else {
    log('No iframe found!', 'error');
  }
}

async function main() {
  try {
    setStatus('Creating virtual file system...', 'loading');
    log('Creating virtual file system...');
    vfs = new VirtualFS();

    setStatus('Setting up project...', 'loading');
    log('Creating Convex App project structure...');
    createConvexAppProject(vfs);
    log('Project files created', 'success');

    // List key files
    log('');
    log('Project files created', 'success');
    log('');

    setStatus('Initializing runtime...', 'loading');
    log('Initializing runtime...');
    const runtime = new Runtime(vfs, {
      cwd: '/',
      env: { NODE_ENV: 'development' },
      onConsole: (method, args) => {
        const msg = args.map(a => String(a)).join(' ');
        if (method === 'error') log(msg, 'error');
        else if (method === 'warn') log(msg, 'warn');
        else log(msg);
      },
    });

    setStatus('Starting dev server...', 'loading');
    log('Starting Next.js dev server...');

    const port = 3002;
    devServer = new NextDevServer(vfs, {
      port,
      root: '/',
      preferAppRouter: true,
    });
    const server = devServer;

    const bridge = getServerBridge();

    try {
      log('Initializing Service Worker...');
      await bridge.initServiceWorker();
      log('Service Worker ready', 'success');
    } catch (error) {
      log(`Service Worker warning: ${error}`, 'warn');
    }

    // Create HTTP server wrapper
    const httpServer = {
      listening: true,
      address: () => ({ port, address: '0.0.0.0', family: 'IPv4' }),
      async handleRequest(
        method: string,
        url: string,
        headers: Record<string, string>,
        body?: string | Buffer
      ) {
        const bodyBuffer = body
          ? typeof body === 'string' ? Buffer.from(body) : body
          : undefined;
        return server.handleRequest(method, url, headers, bodyBuffer);
      },
    };

    bridge.registerServer(httpServer as any, port);
    server.start();

    serverUrl = bridge.getServerUrl(port) + '/';
    log(`Server running at: ${serverUrl}`, 'success');
    log('');

    // Set up HMR logging
    server.on('hmr-update', (update: unknown) => {
      log(`HMR: ${JSON.stringify(update)}`, 'success');
    });

    // Watch for file changes
    vfs.watch('/app', { recursive: true }, (event, filename) => {
      log(`File ${event}: ${filename}`);
    });

    setStatus('Running', 'running');

    // Show iframe
    previewContainer.innerHTML = '';
    iframe = document.createElement('iframe');
    iframe.src = serverUrl;
    iframe.id = 'preview-iframe';
    iframe.name = 'preview-iframe';
    // Allow scripts but prevent navigation of parent window
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');

    // Set up onload handler to inject Convex URL into iframe's window
    iframe.onload = () => {
      if (convexUrl && iframe?.contentWindow) {
        (iframe.contentWindow as any).__CONVEX_URL__ = convexUrl;
        log(`Injected Convex URL into iframe: ${convexUrl}`);
      }
    };

    previewContainer.appendChild(iframe);

    // Enable buttons
    refreshBtn.disabled = false;
    openBtn.disabled = false;
    deployBtn.disabled = false;

    refreshBtn.onclick = () => {
      if (iframe) {
        log('Refreshing preview...');
        iframe.src = iframe.src;
      }
    };

    openBtn.onclick = () => {
      if (serverUrl) {
        window.open(serverUrl, '_blank');
      }
    };

    deployBtn.onclick = async () => {
      const key = convexKeyInput.value.trim();
      if (!key) {
        logStatus('ERROR', 'Please enter a Convex deploy key');
        return;
      }

      deployBtn.disabled = true;
      deployBtn.textContent = 'Deploying...';
      // Remove success class in case this is a re-deployment
      deployBtn.classList.remove('success');

      try {
        await deployToConvex(key);
        deployBtn.textContent = 'Connected!';
        deployBtn.classList.add('success');
        // Re-enable button to allow re-deployment without page refresh
        deployBtn.disabled = false;
        log('Convex connected! The app will now use real-time data.', 'success');
        log('You can click "Deploy Schema" again to re-deploy if needed.', 'info');
      } catch (error) {
        logStatus('ERROR', `Deployment failed: ${error}`);
        deployBtn.textContent = 'Deploy Schema';
        deployBtn.disabled = false;
      }
    };

    log('Demo ready!', 'success');
    log('');
    log('To connect to Convex:');
    log('  1. Enter your Convex deploy key above');
    log('  2. Click "Deploy Schema"');
    log('  3. The app will connect to your Convex backend');
    log('');
    log('Files in /convex/ folder:');
    log('  /convex/schema.ts - Database schema');
    log('  /convex/todos.ts - Query and mutation functions');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Error: ${errorMessage}`, 'error');
    console.error(error);
    setStatus('Error', 'error');
  }
}

// Start the demo
main();
