# Contrats partagés des environnements exécutés

Ce répertoire fournit les briques communes qui permettent à l’application, au
Manager et aux commandes de contrôle d’interpréter un environnement de la même
façon. Il évite de dupliquer les règles de sélection du CLI et de préparation
des prévisualisations dans plusieurs composants.

## Contenu

- `managed-cli.*` décrit la sélection persistante du CLI et ses protections.
- `preview-profile.*` décrit les profils et recettes d’environnement de test.
- `preview-archive.*`, `preview-snapshot.py` et `preview-storage.*` préparent
  les sources et décrivent le stockage temporaire géré.
- `preview-gateway.*` fournit le relais HTTP et WebSocket des prévisualisations.
- Les fichiers de déclarations TypeScript accompagnent les modules CommonJS ;
  les tests vérifient leurs contrats. `testing.*` aide les fixtures isolées.

Une modification doit rester compatible avec tous ses consommateurs. Ce dossier
ne contient ni les données d’une prévisualisation, ni un moyen de contourner le
Manager, le proxy, les permissions ou le sandbox.

Voir [Prévisualisations des agents](../docs/previsualisations-agents.md) et
[CLI géré](../docs/operations/managed-codex-runtime.md).
