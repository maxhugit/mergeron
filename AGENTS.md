# Développer Mergeron

Ces consignes concernent le code de ce dépôt. Lire [Contribuer](CONTRIBUTING.md)
avant de modifier le code et [Sécurité](SECURITY.md) pour les changements sensibles.

## Sources de consignes

Le présent fichier est versionné avec le dépôt. Il ne remplace pas le fichier
AGENTS.md des connaissances partagées du projet géré par Mergeron. Ne pas copier
ni écraser ces connaissances depuis Git. Leur articulation est décrite dans
[Administration Codex](docs/administration-codex.md#consignes-du-dépôt-et-consignes-du-projet).

Avant de modifier un domaine, lire ses consignes même si la session a démarré
à la racine : [backend](src/AGENTS.md), [interface](web/AGENTS.md),
[déploiement](deployment/AGENTS.md). Ne pas supposer que tous les fichiers
des sous-dossiers sont chargés automatiquement.

## Règles communes

- Préserver la compatibilité avec codex app-server et les contrats existants.
- Ne jamais enregistrer de secrets, données privées du homelab ou sauvegardes dans Git.
- Préserver les contrôles de droits, le sandbox et les restrictions Docker et réseau.
- Distinguer développement, publication d’image et déploiement. Une demande
  concernant la DEV n’autorise aucune modification de la production.
- Utiliser Node et pnpm selon CONTRIBUTING.md et les versions épinglées du dépôt.
- Exécuter les validations adaptées à la modification et les contrôles CI requis.
  Corriger les échecs sans supprimer les assertions ou affaiblir les protections.
- Mettre à jour la documentation et le guide intégré concernés dans la même PR.
- Rapporter les changements, validations réellement effectuées et blocages.
  Ne pas annoncer une fusion ou un déploiement sans vérification.

Garder ces consignes courtes et durables. Les états temporaires de branche,
journaux et étapes restantes appartiennent à la PR ou au résumé de reprise.
