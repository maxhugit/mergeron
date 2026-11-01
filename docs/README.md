# Documentation française

[← Accueil du dépôt](../README.md#documentation)

Ce répertoire explique comment installer, utiliser, administrer et faire évoluer
Mergeron. Les guides fonctionnels décrivent les parcours et leurs protections ;
les références techniques détaillent l’architecture, les contrats et les contrôles.
Pour situer le code, consulter les [répertoires racine du dépôt](../README.md#répertoires-du-dépôt).

## Installer et exploiter sur Docker

Le [premier administrateur et ses contrôles techniques](initial-admin-setup.md)
se configurent dans l’assistant Web, sans fichier de compte à préparer.

1. [Installer Mergeron avec le Manager](installation.md)
2. [Variables du Manager : défauts, rôle et utilisation](variables-manager.md)
3. [Raccordement réseau et SSO facultatif](installation-portable.md)
4. [Architecture de Mergeron](architecture.md)
5. [Fonctionnement du dépôt](fonctionnement-du-depot.md)
6. [Configuration des intégrations facultatives](configuration-integrations.md)
7. [Mergeron Manager](mergeron-manager.md)
8. [Sauvegarde et restauration](sauvegarde-restauration.md)
9. [Exploitation et dépannage](exploitation-depannage.md)
10. [Versions et publications](publications.md)
11. [Audit de neutralité du déploiement](audit-portabilite.md)

Le Manager est le seul parcours d’installation utilisateur. Les
[adaptations aux panneaux hôtes](adapters/README.md) sont facultatives et
séparées du parcours standard. Les proxys HTTPS et fournisseurs d’identité sont
également des choix d’intégration, pas des dépendances à un homelab particulier.

- [Mises à jour des composants](container-updates.md) : détection, confirmation,
  sauvegarde, interruption et suivi.
- [CLI Codex géré et protégé](operations/managed-codex-runtime.md) : provenance,
  installation par le Manager et contrôle des mises à jour.
- [Prévisualisations des agents](previsualisations-agents.md) : domaine wildcard,
  images approuvées, autorisation projet, MCP et nettoyage des instances.
- [Mise à jour rapide en dev](dev-fast-update.md).
- [Récupération de session sans rechargement](session-recovery.md).
- [Ancien point d’entrée Installation Docker](installation-docker.md) :
  redirection documentaire vers le parcours Manager actuel.

## Guides d’utilisation

- [Guide utilisateur intégré et maintenance](guide-utilisateur.md) : sommaire
  par fonctionnalités, recherche, articles français/anglais et vérifications.
- [Export et import des projets en ZIP](export-import-projets.md) : transfert
  production/development, contenu, sécurité et compatibilité entre versions.
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
- [Installation de la PWA et notifications](pwa-installation.md).
- [Import : correspondance des personnes](import-person-mapping.md).
- [Tester les droits avec une autre identité](admin-impersonation.md).
- [Versions documentaires produites par les agents](agent-document-versions.md).
- [Onglets des espaces de travail](workspace-tabs.md).
- [Commandes slash](slash-commands.md).
- [Copie des réponses avec mise en forme](formatted-response-copy.md).

## Emplacements et connexions des projets

- [Évolution de la notion de workspace](evolution-workspaces.md).
- [Modèle transitoire des emplacements et connexions](project-locations-model.md)
  (référence de migration).
- [Interface des emplacements](project-locations-ui.md).
- [Consommateurs du modèle d’emplacements](project-locations-consumers.md).
- [Dossier d’exécution et racines autorisées](project-execution-locations.md).
- [Restrictions MCP par projet](project-mcp-restrictions.md).

## Conversations et récupération

- [Branches de conversation](conversation-branches.md).
- [Récupération et découverte des conversations](conversation-recovery.md).
- [Affichage des éléments d’un tour terminé](completed-turn-items.md).
- [Concurrence des opérations de récupération](recovery-concurrency.md).
- [Récupération des politiques de conversation](thread-policy-recovery.md).

## Développement et sécurité

- [Contribuer](../CONTRIBUTING.md)
- [Maintenance du code](maintenance-code.md) : nettoyage des éléments inutilisés,
  lectures regroupées et maintien de la couverture des tests.
- [Performance et stabilité du code](performance-et-stabilite.md) : mesures du
  backend, abonnements frontend et organisation de la CI.
- [Interface Web](../web/README.md)
- [Caches et précontrôle de l’environnement des agents](environnement-agents.md)
- [Vérification visuelle du vrai site](verification-visuelle.md)
- [Environnement de test par agent](environnement-test.md) : lancement isolé,
  compte local et rechargement à chaud avec Nest/Fastify et Vite.
- [Politique de sécurité](../SECURITY.md)
- [Évaluation des composants système](../security/system-components.md)
- [Évaluation des en-têtes noyau](../security/linux-libc-dev-assessment.csv)

## Références et adaptations

- [Adaptations aux panneaux hôtes](adapters/README.md), dont [Unraid](adapters/unraid.md).
- [Références officielles figées](upstream/README.md).
- [Référence historique du protocole Codex 0.153.2](upstream/codex-app-server-0.153.2.md).
- [Rétroportage des correctifs libxml2](../security/libxml2-backport.md).
- [Rétroportage des correctifs OpenSSH](../security/openssh-backport.md).
- [Compétence de travail sur les fichiers bureautiques](../skills/office-files/SKILL.md).
- [Organisation des catalogues de traduction](../web/src/locales/README.md).

Le répertoire `upstream/` conserve des références officielles figées dans leur langue d’origine.
Ces documents ne sont pas nécessaires à l’installation. Les guides fonctionnels
suivent `main`/`edge` ; vérifier la révision installée et les notes de version
avant de supposer qu’une ancienne version stable possède toutes ces fonctions.
