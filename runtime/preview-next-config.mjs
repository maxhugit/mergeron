/** Explicit development-only integration for Next.js Webpack; adds only the exact Manager-selected development hostname. */
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { writeFileSync, renameSync } from 'node:fs';
import state from './preview-next-state.cjs';
const loader = fileURLToPath(
  new URL('./preview-next-css-loader.cjs', import.meta.url),
);
const client = fileURLToPath(
  new URL('./preview-next-client.cjs', import.meta.url),
);
export function withMergeronPreview(configuration = {}) {
  if (typeof configuration === 'function')
    return (...args) => {
      const result = configuration(...args);
      return result?.then
        ? result.then(withMergeronPreview)
        : withMergeronPreview(result);
    };
  const publicHost = process.env.MERGERON_PREVIEW_PUBLIC_HOST;
  const approvedHost =
    process.env.NODE_ENV === 'development' &&
    process.env.MERGERON_PREVIEW_RECEIPT_PATH &&
    process.env.MERGERON_NEXT_DIAGNOSTICS_STATE_PATH &&
    typeof publicHost === 'string' &&
    publicHost.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
      publicHost,
    ) &&
    (configuration.allowedDevOrigins === undefined ||
      Array.isArray(configuration.allowedDevOrigins));
  return {
    ...configuration,
    ...(approvedHost
      ? {
          allowedDevOrigins: [
            ...new Set([
              ...(configuration.allowedDevOrigins ?? []),
              publicHost,
            ]),
          ],
        }
      : {}),
    webpack(config, context) {
      if (configuration.webpack)
        config = configuration.webpack(config, context);
      const receiptPath = process.env.MERGERON_PREVIEW_RECEIPT_PATH;
      const statusPath = process.env.MERGERON_NEXT_DIAGNOSTICS_STATE_PATH;
      if (!context.dev || !receiptPath || !statusPath) return config;
      const { webpack, isServer } = context;
      config.plugins.push(
        new webpack.DefinePlugin({
          'process.env.MERGERON_PREVIEW_BUILD_GENERATION':
            webpack.DefinePlugin.runtimeValue(
              () => JSON.stringify(state.generation(receiptPath) ?? ''),
              { fileDependencies: [receiptPath] },
            ),
        }),
      );
      // Append at compilation time so Next retains its built-in CSS pipeline.
      config.plugins.push({
        apply(compiler) {
          compiler.hooks.compilation.tap(
            'MergeronPreviewCss',
            (compilation) => {
              webpack.NormalModule.getCompilationHooks(compilation).loader.tap(
                'MergeronPreviewCss',
                (_context, module) => {
                  if (
                    /\.css$/.test(module.resource ?? '') &&
                    !/\.module\.css$/.test(module.resource ?? '') &&
                    !module.loaders.some((item) => item.loader === loader)
                  )
                    module.loaders.push({ loader, options: { receiptPath } });
                },
              );
            },
          );
        },
      });
      if (isServer) return config;
      const entry = config.entry;
      config.entry = async () => {
        const entries = typeof entry === 'function' ? await entry() : entry;
        for (const key of ['main', 'main-app']) {
          if (!entries[key]) continue;
          const value = entries[key];
          entries[key] = Array.isArray(value)
            ? [client, ...value]
            : typeof value === 'string'
              ? [client, value]
              : {
                  ...value,
                  import: [client, ...[].concat(value.import ?? [])],
                };
        }
        return entries;
      };
      config.plugins.push({
        apply(compiler) {
          let startedGeneration = null;
          const save = (value) => {
            try {
              writeFileSync(statusPath + '.tmp', JSON.stringify(value), {
                mode: 0o600,
              });
              renameSync(statusPath + '.tmp', statusPath);
            } catch {
              /* Missing observation remains unknown, never ready. */
            }
          };
          compiler.hooks.watchRun.tap('MergeronPreviewDiagnostics', () => {
            startedGeneration = state.generation(receiptPath);
            save({
              generation: null,
              watching: true,
              phase: 'updating',
              hash: null,
            });
          });
          compiler.hooks.afterCompile.tap(
            'MergeronPreviewDiagnostics',
            (compilation) => {
              compilation.fileDependencies.add(receiptPath);
              compilation.contextDependencies.add(dirname(receiptPath));
            },
          );
          compiler.hooks.done.tap('MergeronPreviewDiagnostics', (stats) => {
            const current = state.generation(receiptPath);
            save({
              generation:
                !stats.hasErrors() && current === startedGeneration
                  ? current
                  : null,
              watching: true,
              phase: stats.hasErrors() ? 'error' : 'applied',
              hash: stats.hash ?? null,
            });
          });
          compiler.hooks.watchClose.tap('MergeronPreviewDiagnostics', () =>
            save({
              generation: null,
              watching: false,
              phase: 'idle',
              hash: null,
            }),
          );
        },
      });
      return config;
    },
  };
}
