# Repository Guidelines

## Project Structure & Module Organization

This is a Yarn 1 monorepo for BooxDraw, an Excalidraw fork wrapped with Capacitor for Android. The main web app lives in `excalidraw-app/`; shared library packages live in `packages/*`; examples are in `examples/`; static public assets are in `public/`. Android wrapper code is under `android/`, with native Boox/Onyx pen integration in `android/app/src/main/java/com/edsonmatematico/benehimedraw/onyxpen/`. The GitHub Pages room-code resolver is in `docs/`. App tests are primarily in `excalidraw-app/tests/`, with shared test setup in `setupTests.ts`.

## Build, Test, and Development Commands

- `yarn install`: install workspace dependencies using Yarn 1.22.x.
- `yarn start`: run the Vite development server for `excalidraw-app`.
- `yarn build`: build the web app and version metadata.
- `npx cap sync android`: sync the built web app into the Capacitor Android project.
- `cd android && ./gradlew assembleDebug`: build a debug APK.
- `yarn test`: run Vitest.
- `yarn test:all`: run typecheck, ESLint, Prettier checks, and Vitest once.
- `yarn fix`: run Prettier and ESLint autofixes.

## Coding Style & Naming Conventions

Use TypeScript/React patterns already present in `excalidraw-app` and `packages`. EditorConfig requires UTF-8, LF endings, two-space indentation, trailing whitespace removal, and final newlines. Prettier uses `@excalidraw/prettier-config`; ESLint uses the Excalidraw/react app configuration. Prefer `PascalCase` for React components, `camelCase` for functions and variables, and colocated `.scss` files for component styles where existing code does so.

## Testing Guidelines

Use Vitest with jsdom/canvas mocks for web tests. Name tests descriptively with `.test.ts` or `.test.tsx`, and place app-level tests in `excalidraw-app/tests/` unless a package has its own local test pattern. Run `yarn test:app --watch=false` before submitting behavior changes, and run `yarn test:all` for broader changes touching shared packages, build config, or Android/WebView bridge behavior.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, usually Title Case, such as `Restore idle Onyx stroke batching` or `Add APK build workflow`. Keep commits focused and avoid mixing formatting churn with behavior changes. Pull requests should include a concise description, linked issue when available, test commands run, and screenshots or device notes for UI, Android, stylus, or e-ink rendering changes.

## Security & Configuration Tips

Do not commit local secrets or production credentials from `.env.*`, Firebase, or signing configuration. Treat room codes as convenience links, not secure authentication. For Android changes, avoid committing generated build outputs unless they are intentional Capacitor assets needed by the project.
