# Interface Web

Ce répertoire fournit les écrans dans lesquels l’utilisateur organise ses
projets, échange avec les agents, consulte ses fichiers et suit les opérations.
Il contient aussi les ressources PWA, le guide intégré et l’extension navigateur.

L’interface utilise React 19 et Vite 8. Elle communique avec le backend par les
routes REST `/api/*` et Socket.IO. En production, le résultat de la compilation
est servi par le backend NestJS ; aucun serveur frontal séparé n’est nécessaire.

## Commandes

```bash
pnpm dev
pnpm build
pnpm test
pnpm test:watch
pnpm lint
pnpm generate:api
```

## Organisation

| Chemin               | Contenu                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `src/routes/`        | pages de l’application                                                  |
| `src/components/`    | composants de l’interface                                               |
| `src/stores/`        | états Zustand                                                           |
| `src/hooks/`         | hooks Socket, conversations, affichage et fichiers                      |
| `src/generated/api/` | client généré depuis OpenAPI, à ne pas modifier manuellement            |
| `src/test/setup.ts`  | initialisation des tests Vitest                                         |
| `browser-extension/` | sources de l’extension locale associée à Mergeron                       |
| `public/`            | ressources statiques de l’interface                                     |
| `scripts/`           | préparation de l’extension et contrôles propres au frontend             |
| `tests/`             | cas manuels explicitement ouverts dans un navigateur, hors suite Vitest |

Les tests sont placés à côté des fichiers concernés avec l’extension `.spec.ts`
ou `.spec.tsx`.

Les fichiers `.browser.tsx` exécutent des interactions réelles dans Chromium et
WebKit. Les anciennes fenêtres retirées de l’application ne doivent pas être
conservées uniquement pour faire passer une fixture : tester le parcours utilisé.
Ne pas modifier à la main les clients générés, les dépendances installées ni les
captures temporaires. Voir [Contribuer](../CONTRIBUTING.md).
