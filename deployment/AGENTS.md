# Déploiement Mergeron

Complément aux [consignes racine](../AGENTS.md). Lire les
[principes de déploiement](README.md) et le [guide d’installation](../docs/installation.md).

- Le Manager est le parcours d’installation pris en charge. Ne pas introduire
  de procédure utilisateur parallèle de déploiement Compose.
- Séparer DEV et production : identifier l’instance et l’image visées avant toute
  opération. Ne pas toucher à la production sans instruction explicite applicable.
- Préserver les données persistantes, droits, restrictions Docker et réseau.
  Ne pas résoudre un échec en désactivant TLS, le sandbox ou l’isolation.
- Utiliser une référence d’image précise pour une opération reproductible ;
  vérifier l’état réel après déploiement et conserver une possibilité de retour.
- Ne pas versionner les secrets ou configurations privées de l’hôte.
- Répercuter les changements dans les guides d’installation, variables du
  Manager et adaptations concernées, conformément à CONTRIBUTING.md.
- Valider les scripts et configurations modifiés avec les contrôles existants ;
  distinguer validation locale, CI et vérification sur l’instance cible.
