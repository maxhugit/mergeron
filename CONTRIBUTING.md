# Contribuer au projet

## Signaler un problème ou proposer une amélioration

Rechercher d’abord dans les [issues existantes](https://github.com/maxhugit/mergeron/issues),
y compris celles déjà fermées, puis ouvrir le formulaire adapté :

- [Signaler un bug](https://github.com/maxhugit/mergeron/issues/new?template=bug_report.yml) :
  version installée ou SHA, environnement, étapes minimales, résultats attendu et
  observé, fréquence et extraits de diagnostic nettoyés.
- [Proposer une amélioration](https://github.com/maxhugit/mergeron/issues/new?template=feature_request.yml) :
  besoin concret, personnes concernées, bénéfice, comportement attendu et critères
  de réussite ; une demande par évolution cohérente.

Le guide intégré propose ces parcours dans **Aide et contributions**. Les issues
sont publiques : ne pas joindre de secret, conversation privée, base ou sauvegarde
complète. Pour une vulnérabilité, suivre [le signalement privé](SECURITY.md).
L’envoi d’une demande ne garantit ni réalisation ni délai.

## Principes

- préserver la compatibilité avec `codex app-server` ;
- ne jamais intégrer de secret ou de donnée du homelab dans Git ;
- documenter en français les changements propres au déploiement serveur ;
- conserver les restrictions Docker et réseau ;
- tester le code avant de publier une nouvelle image.

## Environnement de développement

Prérequis : Node.js 22 ou supérieur et la version de pnpm déclarée dans le champ
`packageManager` du `package.json` racine. La CI épingle sa version de Node.js
dans [.github/workflows/quality.yml](.github/workflows/quality.yml) ; l’utiliser
pour reproduire ses contrôles. Le Manager nécessite lui aussi Node.js 22 minimum.

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
python3 scripts/check-markdown-links.py
python3 -m unittest discover -s scripts -p test_markdown_links.py
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

Tout document Markdown doit être accessible depuis le `README.md` principal
par une chaîne de liens Markdown : ajouter le guide dans le sommaire
`docs/README.md` ou dans un index de répertoire déjà accessible. Un simple nom
de fichier entre accents graves ne constitue pas un lien. Le contrôle CI
`scripts/check-markdown-links.py` vérifie les cibles locales et signale aussi
les documents orphelins, y compris un groupe de pages qui ne se lient qu’entre
elles. Les liens dans les exemples de code ou les commentaires ne comptent
pas comme navigation. Ce contrôle ne valide pas les URL externes ni les ancres
à l’intérieur d’une page.

Si aucun document n’est modifié, la description de la pull request doit indiquer
pourquoi le changement est sans impact utilisateur, administrateur ou migration.

## Déploiement

Une fusion dans `main` construit l’image GHCR. Tester de préférence le tag
immuable `sha-<commit>` avant de modifier l’image utilisée sur serveur.

Toute modification de `deployment/` doit être répercutée dans
`docs/installation.md`, `docs/variables-manager.md` et les adaptations facultatives concernées.
