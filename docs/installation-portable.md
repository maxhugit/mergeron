# Installation Docker indépendante de l’hôte

Mergeron s’installe sur un hôte Docker Linux amd64 compatible avec le sandbox
de l’application. Aucun panneau d’administration, nom de pool, reverse proxy
ou réseau propre à un homelab n’est imposé. Le fichier standard est
`deployment/compose.yml` et l’image officielle est construite avec `Dockerfile`.

## Séparer les responsabilités

- Mergeron Manager gère les trois conteneurs applicatifs et leurs trois réseaux
  privés. Il ne gère pas les services extérieurs au manifeste.
- Le reverse proxy de votre choix termine HTTPS et transmet les connexions
  HTTP, WebSocket et les réponses en continu à **l’ingress sur le port 8080**.
- Le réseau partagé de ce proxy est une dépendance externe, sélectionnée par
  `MERGERON_PROXY_NETWORK`. Le Manager ne le crée, ne le supprime ni ne
  reconfigure votre proxy. Il refuse l’installation s’il manque.
- L’authentification est un choix distinct : **compte et mot de passe par défaut**,
  fournisseur **OpenID Connect au choix uniquement sur activation explicite**,
  mode `native` par défaut
  pour une nouvelle installation. L’adaptateur historique Authentik est
  facultatif et s’active explicitement. Changer de proxy HTTPS n’impose pas de
  changer de fournisseur d’identité.
- OnlyOffice, Home Assistant, MCP et SSH sont des intégrations facultatives.
  Ils ne sont pas requis pour démarrer le Manager.

Ne publier ni le port applicatif 8172, ni Squid, ni le socket Docker sur Internet.
Le Manager conserve `network_mode: none` et son canal Unix local. Les images et
le sandbox requièrent Linux ; Docker Desktop ne constitue pas une validation
de production du sandbox.

## Paramètres de l’installation

| Paramètre                       | Manager                                               | Compose                       | Exemple                        |
| ------------------------------- | ----------------------------------------------------- | ----------------------------- | ------------------------------ |
| Données persistantes            | `MERGERON_STATE_ROOT`                                 | `STATE_ROOT`                  | `/srv/mergeron/state`          |
| Configurations Compose          | —                                                     | `DEPLOY_ROOT`                 | `/srv/mergeron`                |
| Dossiers accessibles aux agents | `MERGERON_APPDATA_ROOT`                               | `MERGERON_APPDATA_ROOT`       | `/srv/mergeron/state/appdata`  |
| Réseau externe du proxy         | `MERGERON_PROXY_NETWORK`                              | même variable                 | `shared-proxy`                 |
| Authentification de l’ingress   | `MERGERON_AUTH_MODE`                                  | même variable pour le Manager | `authentik` ou `native`        |
| Modèle ingress Compose          | —                                                     | `MERGERON_NGINX_TEMPLATE`     | `nginx.native.conf.template`   |
| Préfixe / environnement         | `MERGERON_STACK_PREFIX`, `MERGERON_STACK_ENVIRONMENT` | mêmes variables               | `mergeron-dev`, `development`  |
| Sous-réseau administratif       | `MERGERON_ADMIN_SUBNET`                               | même variable                 | CIDR privé libre sur cet hôte  |
| Adresse navigateur              | `MERGERON_WEBUI_URL`                                  | même variable                 | `https://mergeron.example.com` |

Les chemins sont **ceux de l’hôte Docker**, pas ceux de l’ordinateur qui lance
le client Docker. Dans le Manager, le montage `/host-state` doit désigner
exactement `MERGERON_STATE_ROOT`. Conserver aussi les montages `manager-run`
et `manager-state` sous cette même racine.

Limiter les montages aux dossiers utiles plutôt qu’exposer tous les fichiers
de l’hôte. Les [adaptations aux panneaux hôtes](adapters/README.md) sont
facultatives. `MERGERON_HOST_INTEGRATION=none` est le mode générique par défaut.

## Installation neuve : choisir un seul propriétaire

### Manager

Créer uniquement le conteneur Manager avec les chemins, réseau,
mode d’authentification, URL et tags choisis (`latest` en stable, `edge` pour
la recette), selon [les commandes Docker](installation-docker.md#variante-manager).
Précréer le réseau externe et y raccorder votre proxy.
Activer `MERGERON_INSTALL_ENABLED=true` pour le premier démarrage : le Manager
prépare les fichiers manquants et crée les trois dépendances. Examiner les logs
et le plan si l’installation est bloquée, puis remettre la variable à `false`.
Les dépendances n’ont besoin ni de formulaires individuels ni d’un réconciliateur hôte.
Voir [le fonctionnement du Manager](mergeron-manager.md).

Le mode d’authentification sélectionne le **premier** fichier Nginx créé dans
`STATE_ROOT/config/nginx.conf.template`. Un fichier existant n’est jamais
remplacé : changer seulement la variable ne fait pas basculer une installation.
Le défaut `native` n’ouvre pas l’accès anonyme : provisionner les comptes ou le
fournisseur avant l’exposition publique. Une installation existante reste sur
son modèle sauvegardé, y compris si celui-ci utilise Authentik.

### Docker Compose

Copier `deployment/compose.yml` dans un dossier privé sous le nom
`compose.yml`, `deployment/config/` dans son sous-dossier `config/`, et
`deployment/.env.example` dans `.env`. Adapter les valeurs ci-dessus.
Préparer les secrets et leurs permissions selon
[la procédure Docker](installation-docker.md#préparer-les-données-et-secrets).
Créer aussi le dossier utilisé
pour `/appdata` avec des droits adaptés à l’UID/GID `11002:11002`.

Pour le mode natif, régler les **deux** valeurs :

```dotenv
MERGERON_AUTH_MODE=native
MERGERON_NGINX_TEMPLATE=nginx.native.conf.template
```

Laisser `MERGERON_INSTALL_ENABLED=false` : Compose crée les services, le Manager
les observe. Ne pas faire créer la même pile par les deux simultanément.

```sh
docker network create shared-proxy
# Déclarer aussi ce réseau dans la configuration persistante du reverse proxy.
docker compose --env-file .env -f compose.yml config --quiet
docker compose --env-file .env -f compose.yml up -d
docker compose --env-file .env -f compose.yml ps
```

Ne pas recréer un réseau existant. `shared-proxy` doit correspondre exactement
à `MERGERON_PROXY_NETWORK`. Pour deux piles, utiliser des chemins, préfixes,
domaines et sous-réseaux administratifs distincts ; le réseau de proxy peut être
commun pour les piles créées par le Manager. Pour plusieurs piles Compose,
préférer des réseaux de proxy distincts : Compose ajoute aussi ses alias de
service non préfixés, qui peuvent entrer en collision sur un réseau partagé.
Cibler chaque ingress par son nom complet (`mergeron-ingress` ou
`mergeron-dev-ingress`), jamais une IP éphémère.

## Choisir le reverse proxy

Le contrat entre le proxy et Mergeron est HTTP/WebSocket, pas une API propre
à un fournisseur. Conserver l’en-tête `Host` public, y compris un éventuel port
HTTPS non standard, et transmettre les en-têtes proxy habituels. Les ports
internes `8080`/`8172` ne doivent jamais devenir l’adresse du navigateur.
Les deux modèles ingress utilisent `absolute_redirect off` : les redirections
locales conservent ainsi l’origine publique, indépendamment de Traefik, Caddy,
Nginx Proxy Manager, HAProxy ou d’un autre proxy conforme à ce contrat.

Tous les exemples ci-dessous supposent un proxy conteneurisé raccordé au réseau
choisi et un domaine HTTPS valide. Le proxy est installé et sauvegardé séparément.
Un proxy sur un autre hôte nécessite une liaison privée ou un port publié sur
une interface privée contrôlée : ce cas n’est **pas** configuré automatiquement
par le Manager. Ne publier aucun port sur `0.0.0.0` pour contourner un problème
de raccordement.

### Caddy

```caddyfile
mergeron.example.com {
    reverse_proxy mergeron-ingress:8080
}
```

Caddy gère la montée de connexion WebSocket avec `reverse_proxy`.
[Référence officielle Caddy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

### Nginx Proxy Manager

Créer un **Proxy Host** : domaine public, schéma `http`, hôte
`mergeron-ingress`, port `8080`, WebSocket activé, certificat TLS valide et
redirection HTTPS. Ne pas ajouter de contrôle interactif extérieur sur les
callbacks OnlyOffice ; l’ingress et l’application les protègent déjà. Tester
les réponses en continu et ajuster les délais du proxy si nécessaire.
[Guide officiel Nginx Proxy Manager](https://nginxproxymanager.com/guide/).

### Nginx

Dans votre serveur TLS existant, transmettre `Host`, `X-Forwarded-Proto`,
`X-Forwarded-For`, `Upgrade` et `Connection`, utiliser HTTP/1.1, désactiver la
mise en tampon des réponses et prévoir un délai de lecture long. Ne pas
supprimer le contrôle d’identité dans l’ingress historique.
[Référence officielle WebSocket Nginx](https://nginx.org/en/docs/http/websocket.html).

### Traefik

L’exemple facultatif [deployment/traefik/mergeron.yml](../deployment/traefik/mergeron.yml)
reste disponible. Adapter le domaine, l’entrypoint, le résolveur TLS et le nom
de l’ingress. Aucune étiquette Traefik n’est nécessaire au fonctionnement du
Manager. Éviter une deuxième vérification Authentik devant celle de l’ingress.

## Authentification sans Authentik

### Par défaut : compte et mot de passe

Sans fichier d’authentification préexistant, la méthode locale est activée et
OIDC, ainsi que sa redirection automatique, sont désactivés. Aucun compte ni mot
de passe par défaut n’est créé : provisionner le premier compte administrateur
par le canal privilégié décrit dans
[l’initialisation administrateur](configuration-integrations.md#initialisation-et-récupération-administrateur).
Un identifiant non provisionné est refusé, même si la méthode locale est active.
Un fichier de configuration existant garde ses choix explicites ; cette évolution
ne bascule pas une installation déjà configurée en SSO.

### Fournisseur externe facultatif

Le mode standard repose sur des sessions locales ou le protocole OpenID Connect,
sans nom de fournisseur codé dans son parcours. Un fournisseur exposant une
découverte OIDC, des clés de signature et l’échange de code peut être configuré.
LDAP, SAML et les en-têtes d’identité arbitraires ne sont pas des protocoles
natifs interchangeables : utiliser une passerelle OIDC pour ces systèmes,
plutôt que faire confiance à des en-têtes déclarés par un navigateur.
L’adaptateur Authentik reste disponible avec `MERGERON_AUTH_MODE=authentik` et,
pour Compose, `MERGERON_NGINX_TEMPLATE=nginx.conf.template`.

Le modèle `nginx.native.conf.template` transmet les cookies au backend, efface
les en-têtes d’identité déclarés par le navigateur et **n’injecte pas le jeton
de service dans les requêtes navigateur**. Les routes API et WebSocket restent
protégées par les sessions Mergeron ; `WEBUI_REQUIRE_IDENTITY=true` est conservé.
Les seuls transferts machine OnlyOffice gardent leurs vérifications signées.

Ce mode n’active **aucun compte anonyme** et ne crée pas d’administrateur par
défaut. Une installation vierge sans authentification provisionnée restera
inaccessible au niveau API. Pour une installation existante, activer et tester
les sessions locales ou OIDC depuis l’administration **avant** la bascule.

Pour une installation neuve avec un fournisseur OIDC autre qu’Authentik :

1. Démarrer en accès restreint pour laisser les migrations créer la base.
2. Créer le client OIDC chez votre fournisseur avec la redirection exacte
   `https://mergeron.example.com/api/auth/oidc/callback`.
3. Provisionner une personne administrateur explicitement liée au `sub` vérifié
   du fournisseur via `scripts/provision-person.cjs`, selon
   [la procédure d’initialisation](configuration-integrations.md#initialisation-et-récupération-administrateur).
4. Placer une configuration privée `webui-auth.json` sous
   `STATE_ROOT/home/.codex/`, appartenant à `11002:11002`, mode `0600`, puis
   redémarrer l’application. Sa structure est :

```json
{
  "version": 1,
  "local": {
    "enabled": false,
    "sessionTtlHours": 24,
    "maxFailedAttempts": 5,
    "lockoutMinutes": 15
  },
  "oidc": {
    "enabled": true,
    "issuerUrl": "https://identity.example.com/realms/mergeron",
    "clientId": "mergeron",
    "clientSecret": "REMPLACER_DANS_LE_FICHIER_PRIVE",
    "redirectUri": "https://mergeron.example.com/api/auth/oidc/callback",
    "scopes": "openid profile email",
    "autoRedirect": false
  }
}
```

Ne pas versionner ce fichier. Autoriser dans Squid les domaines du fournisseur
nécessaires à la découverte, aux clés et à l’échange du code. Un fournisseur
interne nécessite une règle privée **ciblée** avant le refus des réseaux privés,
pas la désactivation de cette protection. Une liaison administrateur nécessite
le sujet stable, pas uniquement une égalité d’e-mail.

L’accès initial par comptes locaux seuls exige leur provisionnement préalable ;
ce guide n’ajoute pas de formulaire public d’inscription ou de récupération.

## Conserver une installation existante

**Avant de mettre à jour le Manager**, renseigner explicitement les valeurs
actuellement utilisées : `MERGERON_PROXY_NETWORK`, `MERGERON_STATE_ROOT`,
`MERGERON_APPDATA_ROOT` et `MERGERON_AUTH_MODE`. Les valeurs par défaut des
exemples ne sont pas une instruction de migration. Les alias et chemins
historiques sont décrits dans [les adaptations](adapters/README.md).

Dans Compose, conserver également `STATE_ROOT`, `DEPLOY_ROOT` et les montages
actuels. Le choix `MERGERON_NGINX_TEMPLATE` est désormais obligatoire : si cette
variable manque, Compose refuse de démarrer plutôt que sélectionner implicitement
un autre mode d’authentification lors d’une recréation. Pour une installation
historique Authentik, conserver explicitement `nginx.conf.template` et
`MERGERON_AUTH_MODE=authentik`. Conserver les chemins des trois montages du Manager.
Ne pas remplacer aveuglément une définition enregistrée par les nouvelles valeurs par
défaut. Ne déplacer aucun fichier et ne renommer aucun réseau pour suivre un
exemple documentaire. Une dérive vis-à-vis de l’adoption bloque les opérations ;
ne pas effacer `adoption.json` pour contourner ce contrôle.

Pour basculer volontairement d’Authentik vers les sessions natives : sauvegarder
la base et le modèle ingress, valider l’authentification native et la relève
administrateur, préparer le nouveau modèle en conservant les noms d’upstream
propres à la pile, vérifier sa syntaxe puis redémarrer uniquement l’ingress.
Conserver le modèle précédent pour revenir en arrière. Le Manager ne remplace
jamais votre modèle existant lors d’un changement de variable.

## Recette avant exposition

- DNS/TLS, connexion privée, déconnexion, compte non autorisé refusé.
- Sans cookie ni jeton : API métier refusée ; un faux `X-Webui-Auth-Source: service`
  ne doit donner aucun accès.
- Conversation en continu, reconnexion WebSocket, fichier volumineux.
- OnlyOffice si utilisé : aperçu, téléchargement signé, sauvegarde signée.
- Trois réseaux privés corrects ; seul l’ingress rejoint le réseau externe.
- Redémarrage : mêmes données et aucune création en double ; plan d’installation
  idempotent et état d’adoption conforme.

Les exemples de proxys sont des configurations de raccordement, pas une promesse
de recette réelle sur toutes leurs versions. Vérifier votre variante sur une
pile de développement avant toute bascule de production.
