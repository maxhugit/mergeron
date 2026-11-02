# Évaluations et correctifs de sécurité

Ce répertoire explique les décisions de sécurité concernant les composants
système livrés avec Mergeron et conserve les correctifs nécessaires à leur
construction. Il permet de relier une version, une vulnérabilité et le traitement
effectivement retenu.

## Contenu

- `system-components.*` et `linux-libc-dev.*` conservent les évaluations,
  inventaires et déclarations OpenVEX.
- `libxml2-patches/` contient les correctifs épinglés et leur manifeste ;
  les guides [libxml2](libxml2-backport.md) et [OpenSSH](openssh-backport.md)
  expliquent les rétroportages.
- `codex-netlink/` conserve le correctif ciblé et ses tests pour l’interrogation
  des interfaces réseau par le CLI personnalisé.

Ces fichiers sont des entrées de construction et d’audit, pas des secrets ni des
exceptions générales aux protections. Une évaluation porte sur les versions et
conditions indiquées ; elle ne vaut pas garantie pour toute version future.
Ne pas retirer un correctif ou une évaluation sans vérifier ses consommateurs,
le composant construit et les tests correspondants.

L’image finale actualise `linux-libc-dev` et exige au minimum `6.12.115-2`,
version corrigée pour [CVE-2026-99083](https://security-tracker.debian.org/tracker/CVE-2026-99083).
Ce rafraîchissement reste indépendant du cache des étapes lourdes de compilation.
Le test de l’image vérifie cette borne, l’inventaire des en-têtes et la compilation
C/C++. Les anciennes déclarations OpenVEX restent limitées à leur version exacte :
elles ne sont pas étendues au nouveau paquet. Le rapport brut et le blocage des
vulnérabilités critiques corrigibles sont conservés.

Voir la [politique de sécurité](../SECURITY.md) et
les [composants système](system-components.md).
