# just-node

**Node.js in your browser. Just like that.**

A lightweight, browser-native Node.js runtime environment. Run Node.js code, install npm packages, and develop with Vite or Next.js - all without a server.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)

---

## Features

- **Virtual File System** - Full in-memory filesystem with Node.js-compatible API
- **Node.js API Shims** - 40+ shimmed modules (`fs`, `path`, `http`, `events`, and more)
- **npm Package Installation** - Install and run real npm packages in the browser
- **Dev Servers** - Built-in Vite and Next.js development servers
- **Hot Module Replacement** - React Refresh support for instant updates
- **TypeScript Support** - First-class TypeScript/TSX transformation via esbuild-wasm
- **Service Worker Architecture** - Intercepts requests for seamless dev experience

---

## Quick Start

### Installation

```bash
npm install just-node
```

### Basic Usage

```typescript
import { createContainer } from 'just-node';

// Create a container
const container = createContainer();

// Write files to the virtual filesystem
container.vfs.writeFileSync('/index.js', `
  const message = 'Hello from just-node!';
  console.log(message);
`);

// Execute code
container.runtime.runFile('/index.js');
```

### With npm Packages

```typescript
import { createContainer } from 'just-node';

const container = createContainer();

// Install a package
await container.npm.install('lodash');

// Use it in your code
container.vfs.writeFileSync('/app.js', `
  const _ = require('lodash');
  console.log(_.capitalize('hello world'));
`);

container.runtime.runFile('/app.js');
// Output: Hello world
```

### With Next.js Dev Server

```typescript
import { VirtualFS, NextDevServer, getServerBridge } from 'just-node';

const vfs = new VirtualFS();

// Create a Next.js page
vfs.mkdirSync('/pages', { recursive: true });
vfs.writeFileSync('/pages/index.jsx', `
  import { useState } from 'react';

  export default function Home() {
    const [count, setCount] = useState(0);
    return (
      <div>
        <h1>Count: {count}</h1>
        <button onClick={() => setCount(c => c + 1)}>+</button>
      </div>
    );
  }
`);

// Start the dev server
const server = new NextDevServer(vfs, { port: 3000 });
const bridge = getServerBridge();
await bridge.initServiceWorker();
bridge.registerServer(server, 3000);

// Access at: /__virtual__/3000/
```

---

## Comparison with WebContainers

| Feature | just-node | WebContainers |
|---------|-----------|---------------|
| **Bundle Size** | ~50KB | ~2MB |
| **Startup Time** | Instant | 2-5 seconds |
| **Execution Model** | Browser main thread | Web Worker isolates |
| **Shell** | `just-bash` (POSIX subset) | Full Linux kernel |
| **Native Modules** | Stubs only | Full support |
| **Networking** | Virtual ports | Real TCP/IP |
| **Use Case** | Lightweight playgrounds, demos | Full development environments |

### When to use just-node

- Building code playgrounds or tutorials
- Creating interactive documentation
- Prototyping without server setup
- Educational tools
- Lightweight sandboxed execution

### When to use WebContainers

- Full-fidelity Node.js development
- Running native modules
- Complex build pipelines
- Production-like environments

---

## API Reference

### `createContainer(options?)`

Creates a new container with all components initialized.

```typescript
interface ContainerOptions {
  cwd?: string;           // Working directory (default: '/')
  env?: Record<string, string>;  // Environment variables
  onConsole?: (method: string, args: any[]) => void;  // Console hook
}

const container = createContainer({
  cwd: '/app',
  env: { NODE_ENV: 'development' },
  onConsole: (method, args) => console.log(`[${method}]`, ...args),
});
```

Returns:
- `container.vfs` - VirtualFS instance
- `container.runtime` - Runtime instance
- `container.npm` - PackageManager instance
- `container.serverBridge` - ServerBridge instance

### VirtualFS

Node.js-compatible filesystem API.

```typescript
// Synchronous operations
vfs.writeFileSync(path, content);
vfs.readFileSync(path, encoding?);
vfs.mkdirSync(path, { recursive: true });
vfs.readdirSync(path);
vfs.statSync(path);
vfs.unlinkSync(path);
vfs.rmdirSync(path);
vfs.existsSync(path);
vfs.renameSync(oldPath, newPath);

// Async operations
await vfs.readFile(path, encoding?);
await vfs.stat(path);

// File watching
vfs.watch(path, { recursive: true }, (event, filename) => {
  console.log(`${event}: ${filename}`);
});
```

### Runtime

Execute JavaScript/TypeScript code.

```typescript
// Execute code string
runtime.execute('console.log("Hello")');

// Run a file from VirtualFS
runtime.runFile('/path/to/file.js');

// Require a module
const module = runtime.require('/path/to/module.js');
```

### PackageManager

Install npm packages.

```typescript
// Install a package
await npm.install('react');
await npm.install('lodash@4.17.21');

// Install multiple packages
await npm.install(['react', 'react-dom']);
```

---

## Supported Node.js APIs

### Fully Shimmed Modules

| Module | Status | Notes |
|--------|--------|-------|
| `fs` | Full | Sync + async + promises |
| `path` | Full | All methods |
| `events` | Full | EventEmitter |
| `buffer` | Full | Via browser Buffer |
| `stream` | Partial | Basic readable/writable |
| `http` | Partial | Virtual server only |
| `url` | Full | WHATWG URL API |
| `querystring` | Full | All methods |
| `util` | Partial | Common utilities |
| `process` | Partial | env, cwd, platform |
| `os` | Partial | Basic info |
| `crypto` | Partial | Via WebCrypto |
| `child_process` | Partial | Via just-bash |

### Stubbed Modules

These modules export empty objects or no-op functions:
- `net`, `tls`, `dns`, `dgram`
- `cluster`, `worker_threads`
- `vm`, `v8`, `inspector`
- `async_hooks`, `perf_hooks`

---

## Framework Support

### Vite

```typescript
import { VirtualFS, ViteDevServer, getServerBridge } from 'just-node';

const vfs = new VirtualFS();

// Create a React app
vfs.writeFileSync('/index.html', `
  <!DOCTYPE html>
  <html>
    <body>
      <div id="root"></div>
      <script type="module" src="/src/main.jsx"></script>
    </body>
  </html>
`);

vfs.mkdirSync('/src', { recursive: true });
vfs.writeFileSync('/src/main.jsx', `
  import React from 'react';
  import ReactDOM from 'react-dom/client';

  function App() {
    return <h1>Hello Vite!</h1>;
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<App />);
`);

// Start Vite dev server
const server = new ViteDevServer(vfs, { port: 5173 });
```

### Next.js

Supports both **Pages Router** and **App Router**:

#### Pages Router

```
/pages
  /index.jsx      → /
  /about.jsx      → /about
  /users/[id].jsx → /users/:id
  /api/hello.js   → /api/hello
```

#### App Router

```
/app
  /layout.jsx           → Root layout
  /page.jsx             → /
  /about/page.jsx       → /about
  /users/[id]/page.jsx  → /users/:id
```

---

## Development

### Setup

```bash
git clone https://github.com/user/just-node.git
cd just-node
npm install
```

### Run Tests

```bash
# Unit tests
npm test

# E2E tests (requires Playwright)
npm run test:e2e
```

### Development Server

```bash
npm run dev
```

Open `http://localhost:5173/next-demo.html` to see the Next.js demo.

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- [esbuild-wasm](https://github.com/evanw/esbuild) - Lightning-fast JavaScript/TypeScript transformation
- [just-bash](https://github.com/user/just-bash) - POSIX shell in WebAssembly
- [React Refresh](https://github.com/facebook/react/tree/main/packages/react-refresh) - Hot module replacement for React

---

<p align="center">
  Made with care for the browser
</p>
