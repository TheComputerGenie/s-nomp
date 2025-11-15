# v-nomp

A zero-proof (Verushash) node stratum mining pool based on NOMP, focused on Verus-style coins.

## Features

- Multi-coin pool support via per-coin configuration files
- Stratum protocol with variable difficulty and TLS options
- Payment processing (proportional and PPLNT modes)
- Block notification and P2P daemon integration
- Optional web interface and admin panel

## Requirements

- Linux (recommended for production)
- Node.js 10+ (see `package.json` engines)
- Redis 2.6+
- Running coin daemon(s) for each pool
- Build tools: `build-essential`, `libboost-all-dev`, `python`, `g++`, `make`

## Installation

1. Install system dependencies (Debian/Ubuntu example):
   ```bash
   sudo apt-get update
   sudo apt-get install -y build-essential libboost-all-dev python g++ make
   ```

2. Clone the repository and install Node.js dependencies:
   ```bash
   git clone https://github.com/ComputerGenieCo/v-nomp.git
   cd v-nomp
   npm install
   ```
   This automatically builds the native Verushash module via `postinstall`.

3. Configure the pool:
   - Copy `config_example.json` to `config.json` and edit portal settings.
   - Review and edit pool configurations in `configFiles/` for your coins.

4. Start the pool:
   ```bash
   npm start
   ```

## Configuration

- **`config.json`**: Portal-wide settings including logging, website, clustering, Redis, and default pool options.
- **`configFiles/*.json`**: Per-coin pool definitions, including daemon connections, ports, payment settings, and P2P options.

Key features include variable difficulty per port, TLS support, and switching/profit modes.

See `config_example.json` and `configFiles/vrsc.json` for examples.

## Usage

- **Block Notification**: Use `scripts/cli.js` or `scripts/blocknotify.c` for daemon block notifications.
- **CLI**: Access runtime commands via the configured `cliPort`.
- **Production**: Use process managers like `pm2` for supervision. Ensure Redis security and daemon redundancy.

## Development

- Entry point: `init.js`
- Core libraries: `libs/` (stratum implementation in `libs/stratum/`)
- Native Verushash: `libs/verushash/` (built with node-gyp)
- No formal tests; contributions welcome.

To develop locally:
```bash
npm ci
npm run build-verushash
node init.js
```

## Contributing

Contributions are welcome. Please open issues or pull requests on the [GitHub repository](https://github.com/ComputerGenieCo/v-nomp). Follow existing code style and include tests where applicable.

## License

This project is primarily licensed under the GNU General Public License v3 (GPLv3).
See `LICENSE` for the full text. Some third-party files included in this repository
remain under the MIT License or other permissive licenses; those files retain their
original notices and are listed in `THIRD_PARTY_LICENSES.md`.
