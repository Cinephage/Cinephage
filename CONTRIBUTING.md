# Contributing

Want to contribute? Here's how to get set up.

## Development Setup

### Prerequisites

- Node.js 22 LTS (22.22.2+) or 24 LTS (24.15.0+)
- npm 10 or higher
- Optional: A running download client for integration testing (qBittorrent, Transmission, etc.)

### Getting Started (Bare Metal)

1. Clone the repository:

   ```bash
   git clone --branch dev https://github.com/MoldyTaint/cinephage.git
   cd cinephage
   ```

2. Install dependencies:

   ```bash
   npm ci
   ```

3. Copy the environment example and configure:

   ```bash
   cp .env.example .env
   ```

   Set `BETTER_AUTH_SECRET` in `.env` to a random value generated with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

### Getting Started (Devcontainer)

1. a) VS Code: Open the repository in VS Code and choose **Reopen in Container**.  
   b) IntelliJ IDEA: See the [official documentation](https://www.jetbrains.com/help/idea/dev-containers-starting-page.html) on how to use devcontainers.
2. The container will copy `.env.example` to `.env` (if missing), generate a `BETTER_AUTH_SECRET`, and install dependencies.
3. Start the app from the container shell:
   ```bash
   npm run dev:host
   ```

Notes:

- The devcontainer runs as the `node` remote user, and may remap that user UID/GID to your host user when
  `updateRemoteUserUID` is enabled.
- The `.devcontainer/.env` `PUID`/`PGID` values are used by optional sidecars (`transmission`, `qbittorrent`,
  `sabnzbd`), and can be changed in that file.
- On startup, the devcontainer entrypoint repairs `/workspace` ownership to `node` only when an ownership mismatch is
  detected.
- The devcontainer uses `node:24-trixie-slim` to stay aligned with the project runtime baseline.
- Optional sidecars are available and not started by default:
  - `download-client` profile: Transmission + qBittorrent
  - `usenet-client` profile: SABnzbd

Start optional sidecars from host:

```bash
cd .devcontainer
docker compose --profile download-client up -d transmission qbittorrent
docker compose --profile usenet-client up -d sabnzbd
```

Default sidecar ports:

- Transmission Web UI: `9091`
- qBittorrent Web UI: `8081`
- SABnzbd Web UI: `8080`

## Development Workflow

### Code Style

- We use **Prettier** for code formatting and **ESLint** for linting
- Run `npm run format` before committing to ensure consistent formatting
- Run `npm run lint` to check for linting issues

### Running Tests

```bash
npm run test                # Run all tests
npm run test:unit -- --watch # Run tests in watch mode
```

### Type Checking

```bash
npm run check       # Run svelte-check for TypeScript errors
```

### Dependency Audit

```bash
npm run deps:audit  # Run dependency audit (unused/unlisted packages)
```

### Building

```bash
npm run build       # Build for production
```

## Pull Request Process

1. Fork the repository and create your branch from `dev`
2. Make your changes following the code style guidelines
3. Add or update tests as needed
4. Ensure all tests pass: `npm run test`
5. Ensure type checking passes: `npm run check`
6. Run formatting: `npm run format`
7. Submit a pull request targeting `dev` with a clear description

## Commit Messages

We follow conventional commit messages:

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `style:` Code style changes (formatting, etc.)
- `refactor:` Code refactoring
- `test:` Test additions or modifications
- `chore:` Build process or auxiliary tool changes

Example: `feat: add subtitle auto-download scheduler`

## Releases

The repository uses a two-branch delivery model:

1. `dev` is the integration branch and the target for normal pull requests
2. Pushes to `dev` run CI and publish preview Docker images tagged `dev` and `dev-YYYYMMDD-RUN`
3. `main` is the only stable release branch
4. Pushes to `main` run semantic-release, create the GitHub Release tag (for example `v0.7.0`), and publish stable Docker images from that release only
5. Stable Docker tags are `latest` plus semver tags such as `0.7.0`, `0.7`, and `0`

Supporting automation that updates project dependencies intentionally targets `dev`. [Renovate](https://docs.renovatebot.com/) opens version-update PRs against `dev` weekly. Patch and minor npm bumps auto-merge after a 3-day stability window once CI passes; GitHub Actions bumps auto-merge after 7 days. Major version bumps remain manual. The dependency dashboard issue tracks all pending updates. See [`renovate.json`](renovate.json) for the full policy.

### Commit Types and Version Bumps

| Commit Type                              | Version Bump  | Example                       |
| ---------------------------------------- | ------------- | ----------------------------- |
| `fix:`                                   | Patch (0.0.x) | `fix: correct login redirect` |
| `feat:`                                  | Minor (0.x.0) | `feat: add dark mode`         |
| `feat!:` or `BREAKING CHANGE:`           | Major (x.0.0) | `feat!: redesign API`         |
| `docs:`, `test:`, `style:`, `chore(ci):` | No release    | `docs: update README`         |

### Release Notes

Use conventional commits on work merged through `dev` so semantic-release can compute the next stable version correctly when changes are promoted to `main`.

## Detailed Documentation

For more detailed development guides:

- [Architecture Overview](https://docs.cinephage.net/development/architecture)
- [Svelte 5 Patterns](https://docs.cinephage.net/development/svelte-patterns)
- [Project Structure](https://docs.cinephage.net/development/project-structure)
- [Commit Message Guidelines](https://docs.cinephage.net/development/commits)
- [Adding New Indexers](https://docs.cinephage.net/development/indexers)

## Reporting Issues

When reporting issues, please include:

- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs or error messages
- Your environment (OS, Node version, etc.)

## License

By contributing to Cinephage, you agree that your contributions will be licensed under the GNU General Public License v3.0.
