# Translation catalogs

[Repository overview](../../../README.md#documentation) · [Documentation index](../../../docs/README.md)

The application uses one directory per locale and i18next namespaces. Locale
metadata lives in `manifest.json`; the account language selector is generated
from this manifest rather than hard-coded in a component.

- `en` is the source and fallback locale.
- `fr` contains the French translations.
- `common` contains the shared interface copy and uses stable semantic keys.

Authentication uses the dedicated `authentication` namespace. New domains can
use `common` or add a focused namespace, then register it in `manifest.json`.
Source code always passes semantic keys to i18next; English sentences are
values, never identifiers.

Runtime text received from Codex or the server is resolved by reversing the
English `common` catalog already loaded as the fallback language. There is no
separate source-to-key catalog to maintain or download.

Every locale must expose the same keys and interpolation variables. The catalog
tests and `pnpm check:i18n` enforce this requirement before another language is
enabled. The CI also rejects missing or additional namespaces, missing or
additional keys relative to the English source, incompatible interpolation
variables, non-semantic catalog keys, and natural-language literals passed to
the translation function.

## Add a language

From `web/`, run:

```sh
pnpm i18n:add-locale -- es "Español"
```

The command creates every namespace from the English source and registers the
language in the manifest. Translate the copied values without changing their
keys or `{{variables}}`, then run `pnpm check:i18n` and the unit tests. The new
language automatically appears in **My account** after the application is
rebuilt; no React component or server allow-list needs to be changed.

Catalogs are loaded through dynamic imports. The initial bundle downloads only
the detected language and its fallback when needed, so adding languages does
not add every translation to every user's startup download.
