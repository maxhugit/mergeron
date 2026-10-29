# CLI Codex validé par Mergeron

## Périmètre

Le Manager livre `0.164.0-mergeron.1` (Linux amd64) : sources officielles
`6aaac694803004a63c6f393d153c96d22521a6b9`, correctif Netlink revu et ressources
officielles de la même version. Le binaire reste `codex-cli 0.164.0` ; son identité
de distribution distincte apparaît dans Administration → Codex → Codex CLI.
Ce n’est pas un correctif Node ou Fastify. Le profil seccomp, le proxy,
les protections des fichiers et le sandbox Chromium ne sont pas désactivés.

## Construction et confiance

- `Dockerfile.manager` compile la source épinglée avec `--locked`, exécute les
  régressions BPF, puis fabrique `codex-runtime/release.json` : provenance,
  capacité `netlink-route-query-v1`, chemins, tailles et SHA-256 de **tous** les
  fichiers (binaire et ressources). Les outils Rust/npm ne sont pas conservés
  dans l’image finale du Manager.
- Le paquet est livré dans l’image immutable du Manager. Aucune URL, commande,
  archive ou destination fournie par une requête n’est exécutée ou extraite.
- L’empreinte lie le paquet à l’image testée ; elle n’est pas une signature
  indépendante. La racine de confiance reste la paire d’images publiée par la
  chaîne CI Mergeron. Les images de production doivent être épinglées par digest.
- Un identifiant de distribution n’est jamais réutilisé avec d’autres octets.
  Si une reconstruction change le manifeste, il faut une nouvelle révision,
  de nouveaux tests et une nouvelle publication ; l’installateur refuse d’écraser
  le répertoire existant.

## Installation et activation

1. Mettre à jour le Manager **et** l’application compatibles. Ne pas déployer
   uniquement un nouveau Manager contre une ancienne application : l’installation
   exige l’étiquette `io.mergeron.cli-policy=1` de l’image applicative.
2. Dans les réglages CLI administrateur, vérifier l’identifiant et le SHA-256 du
   paquet proposé puis choisir **Installer le CLI validé du Manager**.
3. L’application bloque les nouvelles admissions et vérifie le repos global.
   Le Manager vérifie l’identité de l’application, son architecture et son
   montage home, puis démarre un helper de sa propre image par ID immutable :
   UID/GID 11002, aucun réseau, aucune capacité, rootfs en lecture seule, aucun
   port et aucun socket Docker. Seul le home applicatif est monté en écriture.
   Le helper ne lit ni l’authentification ni la configuration et n’écrit que
   `.codex/webui/cli/releases/`.
4. Le paquet est copié dans un répertoire temporaire, vérifié et renommé. Aucun
   exécutable actif n’est remplacé. Le helper n’active rien et est supprimé.
5. L’application revérifie les octets, la sélection attendue et le repos, puis
   écrit atomiquement sélection, politique et empreintes approuvées avant le
   redémarrage contrôlé de Codex. En cas d’échec, elle restaure l’ancienne
   sélection et tente de relancer l’installation précédente.

Une interruption avant activation laisse au pire un paquet non sélectionné.
Le home persistant conserve politique et sélection lors des redémarrages et des
mises à jour d’images. Le correctif manuel Dev est détecté : l’ancienne copie
reste conservée, mais ne devient pas automatiquement une cible de retour arrière
approuvée. Aucune migration des conversations, fichiers ou versions n’est faite.

## Garde-fous et retour arrière

- Les appels directs aux API d’installation/mise à jour npm sont refusés dans
  l’image Mergeron et dès qu’un CLI personnalisé est détecté, même si le bouton
  de l’interface est contourné. Aucun fallback officiel si le Manager est absent.
- Un retour arrière CLI n’est proposé qu’à une version déjà approuvée et intacte,
  présentant les capacités requises. Le contrôle s’applique aussi côté serveur.
- L’application et les commandes de dispatch vérifient le manifeste, tous les
  fichiers et les aliases. En cas d’altération ou de sélection illisible, elles
  échouent explicitement, sans démarrer silencieusement un CLI legacy.
- Un `CODEX_BIN` externe ne peut pas remplacer une sélection protégée.
- Le Manager refuse un changement d’image applicative qui supprimerait le
  protocole de protection. Le retour arrière transactionnel d’une opération
  échouée reste un rétablissement exact de l’état précédant cette opération.
- Ne jamais modifier le manifeste ou effacer la politique pour « débloquer » une
  mise à jour. Conserver le paquet suspect, vérifier les digests et réinstaller
  une nouvelle révision validée, ou restaurer une version approuvée intacte.

## Préparation de la production — pas un ordre de déploiement

Avant autorisation de mise en production :

1. PR et checks de sources, images, vulnérabilités et tests natifs verts sur le
   même SHA ; aucune dérogation au scan du nouveau Manager.
2. `smoke-test-managed-cli.sh <application> <manager>` valide sur une pile jetable
   sans compte : installation par le socket Manager, activation par l’API admin,
   blocage des mises à jour/rollbacks non approuvés, corruption d’une ressource,
   absence de fallback et persistance après redémarrage. Le CLI réellement
   installé est ensuite testé dans Core avec Node, backend réel et Chromium.
   Les dossiers de cette fixture sont créés par l’utilisateur du runner : un
   helper sans réseau établit leur propriétaire avant de restreindre les modes
   (`run` : root/groupe applicatif, 0750 ; `state` : root/root, 0700). Seule
   `CAP_CHOWN` est nécessaire à cette préparation, jamais `CAP_FOWNER`.
   L'exporteur externe rend uniquement les trois preuves synthétiques autorisées
   (`desktop.png`, `mobile.png`, `report.json`) lisibles par le runner (0644),
   dont l'UID diffère de celui du conteneur. Le dossier de sortie doit être vide ;
   aucun fichier n'est écrasé et aucun mode de donnée privée n'est modifié.
3. Examiner les captures ordinateur/mobile et conserver les rapports et les
   digests des **mêmes** images ; validation Dev avant promotion.
4. Après autorisation explicite seulement : sauvegarde de l’état persistant,
   agents au repos, mise à jour de la paire Manager/application et installation
   du paquet depuis les réglages CLI. Ne jamais compiler sur le serveur prod.
5. Vérifier identité/intégrité, précontrôle depuis un agent, démarrage HTTP et
   captures avec une base de test séparée. Conserver les images et données
   précédentes pour le retour arrière ; ne supprimer aucune sauvegarde réelle.

Pour une nouvelle version officielle, construire et valider une nouvelle
révision du paquet Manager. Ne pas recopier automatiquement le patch sur une
source différente. Une version officielle corrigeant le défaut pourra être
réintroduite dans ce circuit **après** les mêmes tests de non-régression.
