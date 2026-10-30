# Contribuer au projet

## Principes

- préserver la compatibilité avec `codex app-server` ;
- ne jamais intégrer de secret ou de donnée du homelab dans Git ;
- documenter en français les changements propres au déploiement serveur ;
- conserver les restrictions Docker et réseau ;
- tester le code avant de publier une nouvelle image.

## Environnement de développement

Prérequis : Node.js 20 ou supérieur et pnpm 10.

```bash
pnpm install
cd web && pnpm install && cd ..
cp .env.example .env
pnpm start:dev
```

Dans un second terminal :

```bash
cd web
pnpm dev
```

## Vérifications

```bash
python3 scripts/check-no-chinese.py
pnpm lint
pnpm test
cd web && pnpm test
```

## Impact documentaire

Toute évolution visible dans l’interface, nouvelle route, migration de données,
modification de droits ou changement d’exploitation doit être répercuté dans le
manuel français au cours de la même pull request.

Vérifier au minimum :

- `README.md` lorsque les fonctions principales ou l’architecture changent ;
- `docs/README.md` lorsqu’un guide est créé, renommé ou supprimé ;
- le guide fonctionnel concerné pour les écrans, règles métier et migrations ;
- `SECURITY.md` et les évaluations de `security/` pour les changements de
  sécurité ou de dépendances système ;
- les guides d’installation et d’exploitation pour les changements de
  conteneurs, variables, volumes, réseaux ou procédures serveur.

Si aucun document n’est modifié, la description de la pull request doit indiquer
pourquoi le changement est sans impact utilisateur, administrateur ou migration.

## Déploiement

Une fusion dans `main` construit l’image GHCR. Tester de préférence le tag
immuable `sha-<commit>` avant de modifier l’image utilisée sur serveur.

Toute modification de `deployment/` doit être répercutée dans
`docs/installation.md`, `docs/variables-manager.md` et les adaptations facultatives concernées.
