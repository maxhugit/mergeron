# Backend Mergeron

Complément aux [consignes racine](../AGENTS.md).

- Préserver les contrôles d’accès par utilisateur, projet et agent ; valider les
  entrées des routes et outils MCP côté serveur.
- Respecter les cardinalités métier des tâches, sous-tâches et livrables.
  Réutiliser les services métier plutôt que contourner leurs validations.
- Préserver les contrats du runtime Codex, les réponses d’approbation et
  l’isolation des documents publiés.
- Pour modifier un contrat HTTP, synchroniser le schéma OpenAPI et le client
  généré de l’interface selon la configuration existante.
- Pour toute migration, traiter les données existantes et les reprises
  interrompues sans suppression ou écrasement implicite.
- Exécuter les tests pertinents, le lint et la compilation backend requis par la CI.
- Documenter les outils MCP, droits et migrations modifiés dans les guides concernés.
