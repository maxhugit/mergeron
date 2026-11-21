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
- `github-cli-dependencies.patch` verrouille `golang.org/x/net` à `v0.62.0`
  dans les sources officielles de GitHub CLI `v2.103.3`, afin de corriger
  [CVE-2026-78661](https://pkg.go.dev/vuln/GO-2026-6860). Le binaire officiel
  de cette version utilise encore `v0.60.0`.

Le Dockerfile vérifie l’archive source GitHub CLI par SHA-256
(`bb148138a3a2fe023e57c78042fe3b42fc09171c0e8fff4cf983b227b7a2eade`),
applique le correctif à `go.mod` et `go.sum` sans tolérer de contexte approximatif,
puis compile avec Go `1.27.3`, sans modification du verrouillage des dépendances
pendant la compilation (`-mod=readonly`). L’archive provient du
[tag officiel](https://github.com/cli/cli/releases/tag/v2.103.3).
Le binaire se présente comme `2.103.3-mergeron.1` ; ses métadonnées de compilation
doivent confirmer `x/net v0.62.0`. Seul le binaire est copié dans l’image finale.
Le scan HIGH/CRITICAL et les tests réels d’API, pagination et jq du CLI restent
obligatoires, sans exception OpenVEX pour cette dépendance. Ce correctif pourra
être retiré au profit d’un binaire officiel après vérification de ses dépendances
et de son scan de sécurité.

Ces fichiers sont des entrées de construction et d’audit, pas des secrets ni des
exceptions générales aux protections. Une évaluation porte sur les versions et
conditions indiquées ; elle ne vaut pas garantie pour toute version future.
Ne pas retirer un correctif ou une évaluation sans vérifier ses consommateurs,
le composant construit et les tests correspondants.

L’image finale actualise `linux-libc-dev` et exige au minimum `6.12.117-1`,
version corrigée pour [CVE-2026-99083](https://security-tracker.debian.org/tracker/CVE-2026-99083).
Ce rafraîchissement reste indépendant du cache des étapes lourdes de compilation.
Le test de l’image vérifie cette borne, l’inventaire des en-têtes et la compilation
C/C++. Les anciennes déclarations OpenVEX restent limitées à leur version exacte :
elles ne sont pas étendues au nouveau paquet. Le rapport brut et le blocage des
vulnérabilités critiques corrigibles sont conservés.

Voir la [politique de sécurité](../SECURITY.md) et
les [composants système](system-components.md).

## OpenSSL partagé du Manager

Le paquet Debian `libssl3t64` 3.5.7-1~deb13u3 est retiré de l’image Manager
pour CVE-2026-124709 (QUIC), sans exception de scan. Node utilise son OpenSSL
embarqué ; le retrait vérifie les objets partagés chargés, l’inventaire exact
et l’absence d’alias avant toute suppression. Un processus Node neuf teste
ensuite cryptographie et contexte TLS. Les fichiers des bibliothèques et
l’inventaire dpkg sont supprimés ensemble, comme pour zlib.
Voir le [suivi Debian](https://security-tracker.debian.org/tracker/CVE-2026-124709)
et le [correctif borné](../scripts/prune-manager-openssl.mjs).

Le minimum `6.12.117-1` inclut le correctif Debian de
[CVE-2026-99362](https://security-tracker.debian.org/tracker/CVE-2026-99362),
qui bloquait la publication après la PR 522. Le contrôle de version est appliqué
à la construction et revérifié dans l’image. Aucun filtre de vulnérabilité ni
extension OpenVEX n’est ajouté. Cette mise à jour du paquet d’en-têtes ne met
pas à jour le noyau de l’hôte Docker.
