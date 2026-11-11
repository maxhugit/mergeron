# Suivi HTTP indépendant des mises à jour

Le suivi de mise à jour ne doit pas dépendre du conteneur qui redémarre. Deux
relais HTTP sans accès Docker se placent entre le proxy TLS existant (Traefik)
et l’ingress Mergeron. L’application et le Manager peuvent être remplacés sans
arrêter ces relais. Le proxy TLS externe reste hors de la transaction Mergeron.

## Accès et journal

Un administrateur ouvre une autorisation de suivi depuis l’API protégée
`POST /api/settings/manager/update/monitor`. Le Manager émet un jeton aléatoire
valable six heures ; seul son SHA-256 est conservé dans le répertoire public de
suivi. Le navigateur échange le jeton via `POST /_mergeron-update/session`, sous
contrôle de l’origine HTTPS exacte. Il reçoit un cookie Secure, HttpOnly,
SameSite=Strict limité au chemin `/_mergeron-update`. Les secrets ne passent
jamais dans l’URL ou le stockage local du navigateur.

`GET /_mergeron-update/status` exige ce cookie. Le service ne lit qu’un répertoire
de projections : identifiant d’opération, état, étape, plan des étapes, type
sauvegarde seule et horodatages. Aucun
acteur, chemin de sauvegarde, message Docker ou environnement n’y est copié.
La projection est écrite par renommage atomique à chaque étape de la transaction.
Une coupure du producteur conserve la dernière observation ; elle ne signifie
jamais que l’opération est terminée. La page réessaie avec attente progressive.

Pendant une transaction, les navigations HTML reçoivent une page de maintenance
HTTP 200. Les API fonctionnelles répondent temporairement 503 et Retry-After ;
les écritures ne sont jamais rejouées automatiquement. Les WebSockets applicatifs
peuvent se fermer lors du redémarrage : la continuité concerne l’accès HTTP et
le suivi, pas l’exécution de toutes les fonctions pendant une migration SQLite.

## Fenêtre unifiée

La fenêtre de suivi lit directement le journal indépendant : l’API de Mergeron
ne peut plus remplacer son étape courante par un état ancien pendant le
redémarrage. Les étapes portent des noms et suivent le plan réel (sauvegarde
seule, restauration, absence de sauvegarde en Dev, remplacement du Manager).
Elles n’estiment pas le temps restant. La dernière observation reçue reste
visible si la connexion au suivi est interrompue. Une réponse HTML de connexion,
un cookie expiré ou une autre opération ne sont jamais présentés comme un
avancement ; l’identifiant de la première opération reçue est conservé.

Le journal indépendant reste lisible avec son cookie existant pendant la
vérification SSO ; aucun nouvel accès administrateur n’est demandé tant que
cette vérification est suspendue. Les détails techniques sont repliables et
proviennent exclusivement de l’API protégée. L’interface distingue une réussite,
un retour arrière, une interruption et une intervention nécessaire.

**Réduire** masque la fenêtre tout en conservant le reçu de reprise dans cet
onglet. Cela n’annule pas l’opération et ne rejoue aucune écriture. **Voir le
suivi** permet de la rouvrir ; **Fermer** n’efface le reçu qu’après un état
terminal. Le lien indépendant ouvre le même journal dans une page autonome,
sans bundle applicatif ni bibliothèque distante.

La nouvelle fenêtre peut lire les projections des relais déjà installés. Leur
page autonome conserve son ancienne présentation jusqu’à une maintenance
explicite de ces relais ; une mise à jour de l’application ou du Manager ne les
remplace pas automatiquement. Les nouvelles pages autonomes utilisent une
présentation claire/sombre et responsive cohérente avec la fenêtre.

## Installation explicite sur l’hôte

Utiliser une image Manager immuable qui contient ces scripts :

```sh
node manager/scripts/install-update-gateway.mjs \
  --stack=mergeron-dev \
  --hostname=mergeron-dev.example.com \
  --image=ghcr.io/maxhugit/mergeron-manager@sha256:EMPREINTE_VERIFIEE \
  --state-root=/srv/mergeron-dev/state \
  --network=mergeron-proxy \
  --application-middlewares=authentik@file,mergeron-security-headers@file \
  --proxy-directory=/srv/traefik/dynamic
```

Reprendre **dans le même ordre** les middlewares de la route applicative existante
(authentification et en-têtes), en adaptant l’exemple à votre installation.
`--application-middlewares=none` est réservé à une route sans middleware existant.
Lors des exécutions suivantes, la chaîne déjà enregistrée dans le fichier des
relais est conservée si l’option est omise ; sa suppression est refusée. Un fichier
existant illisible n’est jamais écrasé. La route `/_mergeron-update` utilise son
propre jeton de suivi, sans recopier le forward-auth de l’application. Les routes
OnlyOffice existantes restent intactes.

Choisir le **réseau existant partagé par Traefik et l’ingress**, qui peut porter
un autre nom que `mergeron-proxy`. Un réseau absent est refusé avant création de
conteneur. Une tentative interrompue ayant laissé un relais à l’état `created`
peut être reprise sans essayer d’arrêter ce conteneur jamais démarré.

### Droits nécessaires au retour arrière

Avant l’arrêt des services, le plan d’une sauvegarde complète vérifie réellement
la création et la suppression d’un répertoire temporaire dans le parent de
l’installation, sous les droits actuels du Manager. `updateRestoreParentNotWritable`
bloque la mise à jour si ce test échoue. Corriger sur l’hôte le propriétaire de
**ce seul parent**, après vérification du chemin (`chown 0:0 /srv/mergeron/state`
pour l’installation standard). Ne pas utiliser `chown -R` ni modifier les droits
des projets. Le Manager conserve `CHOWN` et `DAC_READ_SEARCH`, sans ajout de
`DAC_OVERRIDE` ni désactivation du sandbox.

La migration des projets préserve également un ancien fichier `.external` vide :
il accompagne les anciennes sources dans `dossiers/sources-importees/.external`.
Il n’est ni supprimé ni traité comme une copie Git. Un fichier non vide, un lien
symbolique ou une structure Git ambiguë reste refusé sans déplacer les données.

Les deux conteneurs doivent passer une vraie sonde HTTP avant l’écriture de la
configuration du fournisseur de fichiers Traefik. Chaque relais s’exécute sous
UID 65532, sans capacité Linux, avec système de fichiers en lecture seule,
limites mémoire/processus et un unique montage en lecture seule du répertoire
`manager-state/maintenance`. Il ne reçoit ni socket Docker ni journal privé.
Le nom public doit correspondre à la route TLS déjà autorisée. Le fournisseur de
fichiers doit être activé et le réseau partagé accessible depuis Traefik.

Après validation du routage, activer `MERGERON_UPDATE_MONITOR_ENABLED=true` dans
le Manager. L’interface établit alors la session de suivi avant de lancer une
mise à jour ; un échange échoué empêche son lancement. La fenêtre de suivi
contient une page indépendante et un lien pour l’ouvrir séparément.

Le relais est une nouvelle frontière réseau : le proxy extérieur ne doit pas
être arrêté par une mise à jour Mergeron. Une mise à jour des relais eux-mêmes
nécessite un retrait préalable du routage et une vérification de chaque nouvelle
instance ; ne pas remplacer les deux simultanément. Le script initial ne
constitue pas un mécanisme de remplacement à chaud garanti du proxy TLS externe.

## Remplacement supervisé du Manager

Lorsque le plan global inclut une image Manager immuable, son empreinte est liée
au fingerprint du plan applicatif. Le Manager vérifie son identité, son réseau
`none` et ses montages existants. L’acceptation est ensuite enregistrée durablement
et le suivi passe immédiatement en préparation, avant le téléchargement de l’image
Manager. Un auxiliaire indépendant est lancé avant l’arrêt des composants. Cet auxiliaire utilise l’image actuellement installée, sans réseau,
avec racine en lecture seule, capacités supprimées et limites de ressources.
Son accès Docker reste réservé à ce processus de remplacement ; les relais HTTP
ne le reçoivent jamais.

Après réussite de la sauvegarde et de la transaction applicative, l’auxiliaire
renomme et arrête l’ancien Manager, puis crée le nouveau avec la spécification
existante : mêmes droits, secrets, montages, limites et réseau. Il attend le
contrôle Docker et une vraie réponse de la sonde Unix. Après validation complète,
l’ancien conteneur Manager arrêté est supprimé,
sans suppression de volumes ni des sauvegardes de données. Son identifiant, son
nom, son image et ses protections sont revérifiés avant suppression. Un échec
de nettoyage conserve la réussite et l’ancien conteneur ; une reprise de
l’auxiliaire réessaie le nettoyage de façon idempotente (jusqu’à trois
redémarrages automatiques). En cas d’échec de mise à jour, l’ancien Manager
reste disponible pour le retour arrière. Les spécifications privées sont écrites
en mode 0600,
avec synchronisation avant renommage du journal de remplacement.

Le nouveau Manager vérifie au démarrage puis chaque minute les auxiliaires de
remplacement de sa propre stack (au maximum 100 par passage). Il ne supprime
qu'un auxiliaire arrêté avec code zéro, dont le journal privé confirme la réussite
et le nettoyage de l'ancien Manager. L'opération courante, l'identité et les
protections du nouveau Manager, sa santé Docker et sa réponse Unix sont vérifiées
avant et après l'archivage des logs. Les 100 dernières lignes Docker (128 Kio
maximum) sont conservées dans `manager-state/replacements/helper-logs/<id>.json`,
en mode 0600, sans effacer le journal de remplacement. Ces archives ne sont pas
supprimées automatiquement. Une erreur conserve le conteneur et affiche un avis
dans Infrastructure ; la vérification suivante réessaie. Les auxiliaires actifs,
échoués, inconnus ou liés à une autre opération restent conservés. Aucun arrêt
forcé, volume, image, fichier de projet ou sauvegarde n'est supprimé par ce passage.

Un échec de santé restaure le Manager précédent. L’état global reste
**intervention nécessaire**, car l’application a pu être mise à jour : cela ne
prétend pas avoir restauré toute la stack. Le retour arrière applicatif isolé
n’est pas proposé pour une opération qui a remplacé le Manager. Une modification
d’identité ou des protections après préparation bloque le remplacement ; aucun
conteneur étranger n’est écrasé. Une reprise de l’auxiliaire reconnaît ses propres
conteneurs par l’identifiant privé de remplacement.

## Vérification reproductible de l’interface

```sh
cd web
node scripts/install-test-browsers.mjs chromium webkit
node scripts/verify-update-monitor.mjs /tmp/mergeron-monitor-visual
```

Ce contrôle utilise uniquement des serveurs HTTP locaux synthétiques. Il vérifie
Chromium et WebKit à 390 et 1280 pixels, l’attente d’une nouvelle opération,
les étapes du remplacement du Manager, la perte puis la reprise de connexion,
un cookie expiré, la réussite confirmée, le retour arrière, une sauvegarde seule,
le refus de changer d’opération et l’absence de débordement horizontal. Il est
également exécuté par le premier shard navigateur en CI. Il conserve les captures et `report.json`. Le contrôle
HTTP final arrête le serveur applicatif local et exige toujours une réponse 200
de la page de maintenance. Ces simulations complètent les tests transactionnels ;
elles ne remplacent pas l’essai d’une mise à jour réelle sur la dev.

Les images anciennes du Manager ne contiennent pas l’auxiliaire de remplacement.
La première activation nécessite donc une installation contrôlée du Manager
compatible sur l’hôte, avec conservation de son ancien conteneur. Le label
`io.mergeron.continuous-updates=1` est vérifié dans l’image immuable source et
cible. Les mises à jour supervisées suivantes utilisent cet auxiliaire.

Les relais et le proxy TLS forment l’infrastructure stable, hors de la transaction
applicative. L’installateur refuse de remplacer un relais existant par une autre
image sans une procédure de retrait du routage ; il conserve les instances en
place. Leur propre évolution nécessite une maintenance distincte avec retrait,
remplacement et vérification d’une seule instance à la fois. Une modification de
leurs protections ou un échec de santé bloque l’activation du nouveau routage.

Une installation historique dont tous les composants sont déjà marqués comme
gérés peut légitimement ne pas posséder de registre d’adoption. La vérification
fonctionnelle conserve ce contrat : inventaire complet et unique, dépôts admis,
réseaux présents, composants gérés et aucune anomalie. Elle refuse les états
non gérés, incomplets ou en dérive. Aucun registre n’est créé ou réécrit pour
faire passer cette vérification.

Le reçu temporaire de l’onglet conserve la disponibilité du suivi indépendant.
Pendant une vérification d’identité ou une reconnexion de transport, la vue de
reconnexion continue d’afficher cette page avec son cookie limité au suivi.
Elle ne rétablit aucun droit applicatif, ne fait pas de requête protégée et ne
remplace jamais un refus d’accès ou un changement d’identité.

## Noms des relais permanents

Les deux conteneurs `mergeron-dev-acces-web-1` et `mergeron-dev-acces-web-2`
(ou le préfixe de la stack concernée) sont actifs en permanence : ils assurent
l’accès HTTP normal et le suivi pendant les mises à jour. Ce ne sont pas des
conteneurs de sauvegarde. Les numéros distinguent deux répliques équivalentes,
pas un serveur principal et un serveur de secours.

Les anciennes installations `*-update-gateway-a/b` restent reconnues par
l’installateur sans duplication ni renommage implicite. Pour les renommer,
exécuter explicitement `manager/scripts/rename-http-relays.mjs` avec les mêmes
arguments `--stack`, `--hostname`, `--image`, `--state-root`, `--network` et
`--proxy-directory` que l’installation. Conserver l’image immuable déjà utilisée.

Le script vérifie les protections et la santé des deux répliques, fait pointer
le proxy vers leurs IP inchangées, puis attend une confirmation HTTPS de la
nouvelle configuration avant le renommage Docker. Il rétablit ensuite le routage
par les nouveaux noms. Aucun conteneur n’est arrêté ou recréé. Un échec du
routage final rétablit d’abord le routage par IP avant de restaurer les noms.

## Détection depuis les autres onglets

Lors d’une reconnexion liée à une interruption de transport, l’interface consulte
le statut du relais indépendant, même si cet onglet n’a pas lancé la mise à jour.
Si une opération est en cours et que le cookie de suivi partagé par le navigateur
l’autorise, la fenêtre de reconnexion affiche automatiquement sa page d’avancement.
La lecture est bornée à quatre secondes et réessayée toutes les cinq secondes.
Une ancienne opération terminée n’est pas utilisée pour expliquer une nouvelle
panne réseau.

Cette détection ne crée aucune autorisation pendant la suspension de session :
elle ne contacte pas l’API applicative pour obtenir un jeton et ne rétablit aucun
droit métier. Sans autorisation de suivi, ou si le relais est indisponible, la
reconnexion habituelle continue. Un refus d’accès ou changement d’identité reste
bloquant. Après vérification de la session, la conversation et son brouillon
reprennent dans le même onglet, sans rechargement complet.

### Inventaire automatique des conteneurs supplémentaires

L’écran **Infrastructure** affiche aussi les conteneurs supplémentaires portant les trois labels `io.mergeron.managed=true`, `io.mergeron.stack=<stack exacte>` et `io.mergeron.component=<rôle>`. Cette découverte s’applique aux relais d’accès web comme aux futurs services, sans liste de noms dans l’interface. Chaque réplique conserve une entrée distincte. Le Manager vérifie à nouveau les labels lors de l’inspection ; les conteneurs disparus ou passés dans une autre stack sont écartés.

Ces entrées sont **observées uniquement** : leurs labels décrivent leur appartenance, sans approuver leur image ou leur configuration pour une opération. Elles ne modifient pas l’empreinte d’adoption, les protections des données du socle ou le plan de mise à jour. Les valeurs des variables d’environnement restent masquées selon la politique habituelle. La suppression d’un relais permanent coupe l’accès HTTP ; sa présence dans cet inventaire ne constitue pas une invitation à le nettoyer.
