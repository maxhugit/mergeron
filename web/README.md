# Interface Web

Ce répertoire fournit les écrans dans lesquels l’utilisateur organise ses
projets, échange avec les agents, consulte ses fichiers et suit les opérations.
Il contient aussi les ressources PWA, le guide intégré et l’extension navigateur.

Voir le [sommaire de la documentation](../docs/README.md) et la
[référence des catalogues de traduction](src/locales/README.md).

L’interface utilise React 19 et Vite 8. Elle communique avec le backend par les
routes REST `/api/*` et Socket.IO. En production, le résultat de la compilation
est servi par le backend NestJS ; aucun serveur frontal séparé n’est nécessaire.

## Commandes

```bash
pnpm dev
pnpm build
pnpm test
pnpm test:watch
pnpm test:browser
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
La CI exécute l’ensemble du catalogue navigateur, indépendamment des tests
unitaires et de la compilation. Voir les
[mesures de performance](../docs/performance-et-stabilite.md).


### Exécution isolée des navigateurs

`pnpm test:browser` exécute Chromium puis WebKit dans deux processus Vitest
successifs. Chaque moteur garde son parallélisme existant (Chromium : deux pages,
WebKit : une seule) et reçoit les mêmes filtres de fichiers et `--shard=n/2`.
Les deux shards CI restent exécutés sur des runners indépendants. Le test de
couverture vérifie la découverte réelle de toutes les spécifications, pour
chaque moteur et chaque shard. Aucun test ni moteur n’est retiré.

Un échec du premier moteur n’empêche pas le second de tourner ; le résultat global
reste en erreur. Les captures sont nettoyées une fois avant le premier moteur,
puis conservées pour les deux. Aucun retry automatique ni masque d’erreur n’est
ajouté. Les arguments qui changent la sélection des moteurs sont réservés ; pour
un diagnostic ciblé sur un seul moteur, utiliser directement Vitest.
