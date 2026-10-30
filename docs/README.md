# Documentation française

## Installer et exploiter sur Docker

1. [Fonctionnement du dépôt](fonctionnement-du-depot.md)
2. [Architecture Docker](architecture.md)
3. [Choisir le propriétaire de la pile](choisir-mode-installation.md)
4. [Installation indépendante de l’hôte](installation-portable.md)
5. [Commandes d’installation Docker](installation-docker.md)
6. [Configuration des intégrations](configuration-integrations.md)
7. [Mergeron Manager](mergeron-manager.md)
8. [Sauvegarde et restauration](sauvegarde-restauration.md)
9. [Exploitation et dépannage](exploitation-depannage.md)
10. [Versions et publications](publications.md)
11. [Audit de neutralité du déploiement](audit-portabilite.md)

Les [adaptations aux panneaux hôtes](adapters/README.md) sont facultatives et
séparées du parcours standard. Les proxys HTTPS et fournisseurs d’identité sont
également des choix d’intégration, pas des dépendances à un homelab particulier.

- [Mises à jour des composants](container-updates.md) : détection, confirmation,
  sauvegarde, interruption et suivi.
- [CLI Codex géré et protégé](operations/managed-codex-runtime.md) : provenance,
  installation par le Manager et contrôle des mises à jour.
- [Prévisualisations des agents](previsualisations-agents.md) : domaine wildcard,
  images approuvées, autorisation projet, MCP et nettoyage des instances.

## Guides d’utilisation

- [Guide utilisateur intégré et maintenance](guide-utilisateur.md) : sommaire
  par fonctionnalités, recherche, articles français/anglais et vérifications.
- [Export et import des projets en ZIP](export-import-projets.md) : transfert
  production/development, contenu, sécurité et compatibilité entre versions.
- [Migration vers Mergeron](migration-mergeron.md)
- [Droits d’accès aux projets](droits-acces-projets.md)
- [Organisation des personnes](organisation-personnes-projets.md)
- [Gestion des livrables](gestion-des-livrables.md)
- [Workspaces des projets](workspaces-projets.md)
- [Navigateur distant interactif](live-browser.md)
- [Extension locale Chrome, Edge et Safari sur Mac](local-browser-extension.md)
- [Navigateur annoté et déploiement du service](navigateur-annote.md)
- [Administration Codex](administration-codex.md)
- [Gestionnaire de tâches](gestionnaire-de-taches.md)
- [Contexte projet et outils des agents](contexte-et-outils-agents.md) :
  fonctionnement utilisateur, permissions, créations et architecture technique.

## Développement et sécurité

- [Contribuer](../CONTRIBUTING.md)
- [Interface Web](../web/README.md)
- [Caches et précontrôle de l’environnement des agents](environnement-agents.md)
- [Vérification visuelle du vrai site](verification-visuelle.md)
- [Environnement de test par agent](environnement-test.md) : lancement isolé,
  compte local et rechargement à chaud avec Nest/Fastify et Vite.
- [Politique de sécurité](../SECURITY.md)
- [Évaluation des composants système](../security/system-components.md)
- [Évaluation des en-têtes noyau](../security/linux-libc-dev-assessment.csv)

`upstream/` conserve des références officielles figées dans leur langue d’origine.
Ces documents ne sont pas nécessaires à l’installation. Les guides fonctionnels
suivent `main`/`edge` ; vérifier la révision installée et les notes de version
avant de supposer qu’une ancienne version stable possède toutes ces fonctions.
