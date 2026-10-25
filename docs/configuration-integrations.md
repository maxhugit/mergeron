# Configuration des intégrations

## Navigation d’administration et outils d’exploitation

L’entrée **Paramètres** de l’en-tête (menu « … » sur mobile) ouvre une
navigation latérale dédiée. **Administration** regroupe les réglages généraux
du serveur, les personnes, le compte, Codex, le chat simple, les réglages des
fichiers et du terminal, la sécurité et les intégrations.
**Outils d’exploitation** donne accès au navigateur global de fichiers et au
terminal global. Ces deux outils ne figurent plus dans la navigation des projets.
Les explorateurs et terminaux des conversations ne sont pas modifiés.

Pendant la session du navigateur, quitter puis rouvrir **Fichiers** conserve
son dossier, le document affiché et la vue (dont le défilement). L’explorateur
global dispose d’un état séparé de ceux des conversations. La vue conservée est
masquée et inactive quand une autre page est affichée. Les changements de nom
et suppressions de fichiers continuent à être répercutés.
**Terminal** conserve déjà ses onglets, la sélection et ses instances attachées
au niveau de la session authentifiée ; naviguer vers une autre page ne ferme
pas les shells. Cette conservation ne garantit pas la survie d’un shell après
redémarrage du serveur ou fermeture complète du navigateur.

Chaque rubrique de réglage dispose d’un lien `/settings?section=…`.
Sur mobile, le bouton de navigation de l’en-tête ouvre le
même menu et la sélection d’une rubrique le referme.

## Personnes, connexion et rôles

Une fiche exige une référence manuelle unique, un prénom, un nom, une adresse
e-mail unique et un numéro de téléphone. Le nom complet est calculé côté serveur
(`Prénom Nom`) ; il n’est pas saisissable. Le rôle par défaut est **Standard**.
Les anciennes fiches sont conservées ; leurs nouveaux champs doivent être
complétés avant leur prochaine modification.

Le proxy Nginx récupère l’identifiant stable et l’e-mail depuis la réponse de son
propre contrôle Authentik, puis écrase les en-têtes d’identité du navigateur.
À la première connexion, une fiche standard active préalablement créée peut être liée par
égalité de l’e-mail, sans tenir compte de la casse. Ensuite seul l’identifiant
stable sert à reconnaître la personne. Les connexions administrateurs exigent
toujours une liaison explicite par identifiant stable via l’outil serveur décrit
ci-dessous : une simple égalité d’e-mail ne suffit pas. Aucune fiche et aucun rôle administrateur
ne sont créés automatiquement. Une fiche déjà liée ne peut pas être récupérée
par un autre identifiant présentant le même e-mail. Une fiche standard déjà liée
peut être promue administrateur par un administrateur existant, après vérification
de la personne : son identifiant stable est alors déjà connu.

En déploiement Unraid, `WEBUI_REQUIRE_IDENTITY=true` refuse toute session humaine
sans identité du proxy. Le backend ne doit pas publier son port sur le réseau
externe. Le jeton technique de déploiement reste un secret administrateur, réservé
aux services internes ; il n’est ni transmis au navigateur ni aux utilisateurs.
Un déploiement local sans cette option conserve le mode historique à clé API,
qui est un accès technique administrateur, pas un compte utilisateur standard.

Les rôles sont relus en base pour chaque requête. Les réglages, intégrations,
informations de compte serveur, journaux techniques et modifications des personnes
sont réservés aux administrateurs côté API, en plus de la protection des pages.
Les listes de personnes servies aux standards ne contiennent pas les coordonnées
ni les identifiants de connexion. Les requêtes de fichiers standards restent
limitées aux workspaces des projets, avec vérification des liens symboliques.
`WEBUI_PROTECTED_PATHS` exclut en plus les répertoires privés du serveur, même
si un projet référence un parent trop large. Adapter en particulier l’alias
`/appdata/mergeron` si le dossier d’installation change ; les secrets et la base
ne doivent jamais devenir des fichiers de projet accessibles aux standards.

Sans isolation système par utilisateur, un répertoire de travail n’est pas une
barrière de sécurité pour un shell ou un agent. Les exécutions d’agents,
automatisations serveur et terminaux (globaux et de conversation) sont donc
réservées aux administrateurs dans ce premier lot. Les standards peuvent utiliser
le chat simple et gérer les tâches manuelles. Leurs appels directs d’exécution
sont refusés côté REST et WebSocket, pas seulement masqués par l’interface.
Ce contrôle de rôles ne remplace pas une future isolation système des agents,
ni une isolation des fichiers et des commandes par projet.

## Applications et MCP par projet

La fenêtre **Paramètres du projet > Connecteurs MCP** contient deux listes :
les serveurs MCP puis les applications Codex. Chaque entrée est simplement
active ou inactive pour le projet. Les applications indisponibles ou désactivées
dans la configuration globale restent visibles mais ne peuvent pas être activées.

Les sélections sont conservées dans la base WebUI. À la création d’une
conversation dont le workspace appartient au projet, le backend ajoute une
couche `config` à `thread/start`. Les applications sont refusées par défaut et
seuls les identifiants sélectionnés sont activés. Chaque serveur MCP connu est
également activé ou désactivé, y compris les MCP fournis par un plugin. Cette
couche ne modifie pas le fichier `config.toml` global et ne contient aucun secret
OAuth. Elle s’applique aux nouvelles conversations ; une conversation déjà
chargée conserve la configuration avec laquelle elle a été démarrée.

Une désactivation ou un changement de rôle déconnecte les sockets de la personne.
Le navigateur revérifie aussi périodiquement son identité. Le dernier
administrateur actif disposant d’une connexion liée ne peut pas être désactivé ou
rétrogradé depuis le formulaire s’il n’existe aucun autre administrateur actif
déjà lié. Une fiche administrateur encore non liée ne constitue pas une relève.

### Initialisation et récupération administrateur

Après démarrage de l’image (et migration de la base), un administrateur Unraid
peut provisionner la première fiche depuis un fichier JSON **privé, hors Git** :

```json
{
  "reference": "ADM-001",
  "firstName": "Prénom",
  "lastName": "Nom",
  "email": "admin@example.com",
  "phone": "+33600000000",
  "role": "administrator",
  "active": true
}
```

```sh
docker exec -i mergeron-ui node /app/scripts/provision-person.cjs < personne-privee.json
```

Ce programme requiert un accès privilégié au conteneur et réutilise la validation
du serveur. Il ne journalise pas les coordonnées. Sauvegarder d’abord la base et
protéger puis retirer le fichier privé après utilisation. En cas de différence
entre l’e-mail de la fiche et celui d’Authentik, ne pas forcer une correspondance
depuis le navigateur : un administrateur peut fournir au même programme le champ
`identitySubject`, lu sur la page `/api/auth/me` après authentification. Cette
liaison explicite doit être vérifiée humainement. Un identifiant déjà lié à une
autre personne est refusé.

### Prévisualisation des documents

Les prévisualisations interactives utilisent `/api/files/preview` et restent
authentifiées par Authentik. OnlyOffice télécharge via `/api/files/serve` avec un
jeton signé valable une heure, limité au chemin du document. Le jeton général de
l’application n’apparaît plus dans la configuration de l’éditeur. Le retour de
sauvegarde OnlyOffice conserve sa validation JWT et son état signé.

## Authentification : OIDC et Authentik facultatif

Le fournisseur n’est pas imposé : le mode ingress `native` utilise les sessions
Mergeron et un fournisseur OIDC compatible sans contrôle proxy Authentik.
Voir [le parcours portable](installation-portable.md#authentification-sans-authentik)
pour l’installation neuve et la bascule sécurisée. Les sections suivantes
conservent Authentik comme exemple et décrivent aussi le mode historique.

Le WebUI prend en charge un fournisseur OpenID Connect avec le flux Authorization
Code, PKCE, `state` et `nonce`. Créer dans Authentik un fournisseur
**OAuth2/OpenID**, puis enregistrer exactement l’URI de redirection :

```text
https://mergeron.example.com/api/auth/oidc/callback
```

Dans **Administration > Réglages généraux du serveur > Authentification**, saisir
l’URL d’émetteur publiée par Authentik, l’identifiant client, le secret client,
l’URI ci-dessus et les portées `openid profile email`. Le serveur vérifie le
document de découverte et ses points de terminaison avant d’accepter
l’activation. Le secret est conservé uniquement dans
`$CODEX_HOME/webui-auth.json`, avec des droits `0600`, et n’est jamais renvoyé au
navigateur.

Une personne standard active préprovisionnée peut être liée lors de sa première
connexion uniquement si Authentik affirme un e-mail vérifié correspondant. Un
administrateur nécessite toujours une liaison explicite de son identifiant
stable ; l’égalité de l’e-mail ne suffit pas à obtenir ce rôle. Le WebUI ne
conserve ni jeton d’accès ni jeton de renouvellement OIDC : il crée sa propre
session opaque, révocable et limitée dans le temps.

### Transition depuis le proxy Authentik

Cette version conserve volontairement le fournisseur proxy existant devant
l’application. Nginx en est l’unique point de contrôle afin d’éviter deux états
de session concurrents entre Traefik et Nginx. Configurer et tester d’abord le
nouveau bouton SSO tout en étant protégé par ce proxy. Ne retirer cette
vérification Nginx que dans une bascule ultérieure, après avoir validé au
minimum :

1. un compte administrateur explicitement lié ;
2. une connexion SSO complète dans une fenêtre privée ;
3. une connexion locale de récupération et la clé API technique ;
4. une sauvegarde de la base et de `webui-auth.json`.

Le fournisseur proxy actuel continue donc à protéger toutes les routes publiques
pendant cette étape.

Nginx réalise la vérification interne auprès de :

```text
http://authentik:9000/outpost.goauthentik.io/auth/nginx
```

Dans ce mode uniquement, le conteneur Authentik et `mergeron-ingress` doivent
partager le réseau choisi par `MERGERON_PROXY_NETWORK` (`mergeron-proxy` par
défaut). Si Authentik n’est pas joignable sous `authentik:9000`, adapter
`$authentik_backend` dans le modèle privé de l’ingress.
Les routes `/outpost.goauthentik.io/*` doivent rester publiques
sur ce domaine. Après configuration, une fenêtre privée doit être redirigée vers
Authentik ; aucune page Mergeron ne doit apparaître avant authentification.

## OpenAI et Codex

L’authentification Codex est conservée sous `STATE_ROOT/home`. Le chat simple
utilise la clé placée dans `STATE_ROOT/openai-api-key.txt`. Ne jamais inscrire
cette clé dans Git, Compose ou une capture d’écran.

Après un redémarrage, vérifier qu’une ancienne conversation se recharge et que
le chat simple retourne une réponse.

## MCP Home Assistant

Configurer l’URL :

```text
https://ha-mcp.example.com/mcp
```

Effectuer OAuth depuis l’interface. Pour une session durable, le fournisseur
doit délivrer un jeton de renouvellement et accepter la portée
`offline_access`. Les données OAuth sont persistées dans `STATE_ROOT/home`.

Valider avec une requête en lecture seule, par exemple la liste de quelques
entités Home Assistant.

## GitHub

Connecter GitHub depuis les paramètres de l’interface. Le jeton ou l’autorisation
OAuth est conservé dans le volume persistant, jamais dans le dépôt. Accorder le
minimum de dépôts et de permissions nécessaires.

## SSH vers Unraid et le VPS

Placer une clé distincte par destination dans `STATE_ROOT/ssh`. Ajouter les clés
publiques dans les comptes distants concernés et enregistrer les empreintes dans
`known_hosts`. Les clés sont montées en lecture seule dans le conteneur.

Éviter une clé root sans restriction. Idéalement, limiter les commandes dans
`authorized_keys` ou utiliser un compte d’administration dédié.

## OnlyOffice

Renseigner l’adresse publique du Document Server :

```text
https://office.example.com
```

Le secret JWT doit être identique dans OnlyOffice et dans Mergeron. Le serveur
OnlyOffice doit pouvoir rappeler les routes de document autorisées sur le
domaine public de Codex. Tester l’ouverture puis l’enregistrement d’un document de
test avant d’utiliser un fichier important.

## PDF et fichiers

Les fichiers sous `/workspaces` et `/appdata` sont visibles dans l’explorateur.
Les PDF s’ouvrent dans la visionneuse intégrée. Les fichiers Office utilisent
OnlyOffice. Les autres formats sont téléchargés ou ouverts selon leur type.
