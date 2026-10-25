# Documentation française

Ce dossier constitue le manuel d’installation et d’exploitation du dépôt. Pour
reconstruire la plateforme sans connaissance préalable, suivre les documents
dans cet ordre :

0. [Installation portable et choix du proxy/authentification](installation-portable.md)

1. [Fonctionnement du dépôt](fonctionnement-du-depot.md)
2. [Architecture sur Unraid](architecture-unraid.md)
3. [Choisir entre DockerMan et Compose Manager](choisir-mode-installation.md)
4. [Installation avec les formulaires Docker standard](installation-unraid-dockerman.md)
5. [Installation avec Compose Manager](installation-unraid.md)
6. [Configuration des intégrations](configuration-integrations.md)
7. [Sauvegarde et restauration](sauvegarde-restauration.md)
8. [Exploitation et dépannage](exploitation-depannage.md)
9. [Versions et publications](publications.md)
10. [Mergeron Manager](mergeron-manager.md)

## Guide d’utilisation

- [Migration vers Mergeron](migration-mergeron.md) : image GHCR, noms des
  conteneurs, formulaires Unraid et conservation des données existantes.

- [Droits d'accès aux projets](droits-acces-projets.md) : participants,
  isolation des données, sessions documentaires et migration.

- [Organisation des personnes](organisation-personnes-projets.md) : chef de
  projet, groupes, affectations historiques et limites actuelles.

- [Gestion des livrables](gestion-des-livrables.md) : fiches facultatives,
  tâche principale, documents, cycle de vie, versions et validation.

- [Workspaces des projets](workspaces-projets.md) : principal permanent,
  secondaires, workspace actif, connaissances partagées et migration des dossiers existants.

- [Administration Codex](administration-codex.md) : listes dynamiques,
  enregistrement par onglet et gestion de la version du CLI.

- [Gestionnaire de tâches](gestionnaire-de-taches.md) : tableau, sous-tâches,
  planning, assistance IA, agents Codex, validation et stockage.

## Documentation destinée aux développeurs

- [Contribuer au projet](../CONTRIBUTING.md)
- [Interface Web](../web/README.md)
- [Politique de sécurité](../SECURITY.md)
- [Évaluation GnuPG, systemd et serveur SSH](../security/system-components.md)
- [Évaluation des en-têtes noyau](../security/linux-libc-dev-assessment.csv)
- notes internes sur les conversations, les espaces de travail et le protocole
  Codex présentes dans ce dossier.

Le sous-dossier `upstream/` contient une copie figée de documents officiels
Codex correspondant à la version utilisée. Ces fichiers sont volontairement
conservés dans leur langue d’origine et ne sont pas nécessaires à
l’installation. Toutes les procédures propres à ce dépôt sont en français.
