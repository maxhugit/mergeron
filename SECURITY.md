# Politique de sécurité

## Signaler une vulnérabilité

Ne pas publier de clé, jeton, adresse privée ou chemin personnel dans une issue.
Utiliser de préférence les avis de sécurité privés GitHub du dépôt.

## Modèle de confiance

Un utilisateur authentifié peut demander à Codex de lire ou modifier les
répertoires montés et d’exécuter des commandes dans le conteneur. Les protections
doivent donc être appliquées par Docker, les volumes, les réseaux, l’authentification et
les permissions de l’hôte, et non par une simple consigne textuelle au modèle.

## Protections attendues

- aucun socket Docker dans les conteneurs applicatifs ; seul le Manager utilise
  l’API Docker locale pour les ressources déclarées dans son manifeste ;
- aucun mode privilégié ;
- système de fichiers du conteneur en lecture seule ;
- capacités Linux supprimées autant que possible ;
- secrets montés en lecture seule et exclus de Git ;
- accès public exclusivement par HTTPS et l’ingress, avec sessions natives ou
  contrôle d’identité ; reverse proxy et fournisseur choisis par l’opérateur ;
- filtrage des sorties Web par Squid ;
- clés SSH limitées et montées en lecture seule ;
- sauvegarde des données persistantes ;
- journaux avec rotation et sans secret.

Le navigateur optionnel géré en production (Manager 0.5.1+) reste séparé de
l’application : utilisateur `pwuser`, racine en lecture seule, sandbox Chromium,
`CapDrop=ALL`, aucune capacité ajoutée, aucun volume ou port hôte. Le Manager
vérifie avant une transaction ses seuls deux réseaux bridge, dont le contrôle
interne, et refuse une topologie inconnue. L’image doit provenir du dépôt
officiel ; le proxy public-only interdit toujours les destinations privées.
Le chemin secret Playwright ne doit apparaître ni dans les diagnostics publics
ni dans Git. Voir [le guide d’exploitation](docs/navigateur-annote.md).

## Métadonnées des mises à jour

Le Manager conserve son réseau `none` et son accès Docker local. Son inventaire
ne considère pas une différence de catalogue OCI multi-plateforme comme une
preuve de mise à jour. Le backend vérifie les manifestes immuables pour la
plateforme installée, via le proxy filtré : seuls les dépôts officiels Mergeron,
NGINX et Squid sont interrogés. Le modèle Squid ajoute uniquement
`auth.docker.io` et `registry-1.docker.io` pour les métadonnées publiques Docker
Hub ; les refus des réseaux privés, TLS et les autres restrictions subsistent.
Pas de téléchargement de couches/configuration d’image, de lancement de helper,
de redirection HTTP, de socket Docker applicatif ou d’identifiant fourni par
l’utilisateur. Les SHA-256 des manifestes sont vérifiés, les tailles et délais
bornés. Une erreur laisse l’état inconnu et bloque la proposition d’installation.

## Premier administrateur

L’[assistant de première configuration](docs/initial-admin-setup.md) nécessite
une autorisation créée par le Manager uniquement sur une installation neuve et
un code aléatoire de 256 bits émis par une commande locale de l’hôte. Ni le premier
visiteur ni une simple adresse e-mail ne confèrent un rôle administrateur. Les
empreintes, l’expiration de 15 minutes et le blocage temporaire sont persistés ;
la session intermédiaire ne donne aucun accès métier. Origine HTTPS épinglée,
cookie `__Host-`, contrôle CSRF et transaction atomique protègent la création.
Le marqueur est fermé avant le commit et masqué aux agents ; un échec est fermé
et exige une reprise explicite sur l’hôte. Une restauration complète d’avant
l’initialisation doit conserver cette fermeture ou être traitée comme une
nouvelle initialisation contrôlée. Les installations existantes ne sont pas
réarmées automatiquement et la console Docker reste une autorité privilégiée.

## Reprise de session

La reprise après inactivité ne recharge pas l’onglet de travail et ne réutilise
pas une identité en cache pour donner accès. Pendant la vérification, l’interface
est masquée et les appels API protégés et le socket sont suspendus sans rejouer
les écritures. Une reconnexion séparée exige une nouvelle vérification serveur
du compte, du rôle et du contexte de test de droits d’origine. Voir le
[parcours de reprise et ses limites](docs/session-recovery.md).

## Contrôles de l’image publiée

Les workflows de qualité et de publication analysent l’image finale avec Trivy,
testent les outils sensibles et conservent les rapports comme artefacts. Les
moteurs 7-Zip fournis par l’image sont installés dans une version épinglée et
leurs fonctions d’extraction sont vérifiées dans un conteneur jetable.

Les décisions OpenVEX ne masquent que des vulnérabilités dont l’implémentation
concernée a été vérifiée comme absente de l’image. Elles ne déclarent pas sûr le
noyau de l’hôte Docker et ne couvrent ni les volumes montés ni les outils ajoutés
après construction. Consulter les éléments d’audit :

- [évaluation GnuPG, systemd et serveur SSH](security/system-components.md) ;
- [inventaire correspondant](security/system-components-assessment.json) ;
- [évaluation des en-têtes noyau](security/linux-libc-dev-assessment.csv) ;
- documents OpenVEX dans [`security/`](security/).

Les vulnérabilités hors périmètre, les composants réellement présents et toutes
les conclusions critiques non justifiées restent visibles dans les rapports.

## Risques résiduels connus

Le réseau `mergeron-admin` permet au conteneur principal d’atteindre les serveurs
et les services administratifs. Les programmes respectant les variables de
proxy utilisent Squid, mais ce réseau constitue aussi une route directe. Les
autorisations SSH et les services accessibles doivent rester strictement limités.

Les chemins `/workspaces` et `/appdata` sont accessibles en écriture car cela
correspond au besoin fonctionnel. Une compromission de Codex pourrait modifier
les fichiers contenus dans ces montages.

L’image contient un client SSH pour les connexions administratives mais aucun
serveur SSH. Les risques propres au client restent applicables et doivent être
suivis séparément des constats concernant `sshd`.

## Secrets à renouveler après exposition

- clé API OpenAI ;
- clés privées SSH ;
- jeton interne entre Nginx et Codex ;
- secret OnlyOffice ;
- jetons OAuth et MCP.

## Accès distants des agents

Une connexion de projet n’est ni un dossier de travail ni une autorisation implicite d’exécution. Les opérations SSH/SFTP/FTP/FTPS des agents exigent l’activation explicite de cette disponibilité, un tour administrateur modifiable sans impersonation et une approbation du transport. Les commandes SSH exigent aussi le mode lecture et écriture ; elles ne sont pas isolées par la racine autorisée aux fichiers. Le compte distant doit imposer les droits adaptés à l’usage.

Les identifiants sont chiffrés côté serveur ; les fichiers temporaires de clé, empreintes et configuration ont des permissions privées et sont retirés après usage. SSH ignore la configuration utilisateur, les agents d’authentification ambiants et les redirections ; les empreintes sont vérifiées strictement. Aucun hôte ni identifiant n’est fourni par l’agent. Les sorties et la durée sont bornées, la révocation est revérifiée et les demandes sont réservées avant l’envoi pour empêcher une répétition après un résultat incertain. FTPS conserve la validation TLS ; FTP reste un choix explicitement non chiffré.

## Reçus de preview et vérification navigateur

Les reçus de transfert sont bornés et liés à l’archive, à l’empreinte de source,
à la copie autorisée et au run courant. Ils sont enregistrés après un transfert
complet ; un échec conserve la génération précédente et son erreur. Ils ne
contiennent aucun secret et n’accordent aucun droit. Le diagnostic HTTPS utilise
la session personnelle existante, revérifie l’identité et la source et ne remet
aucune capacité à l’agent ou à l’application. Les marqueurs HTML/CSS appartiennent
au projet et restent des observations non fiables pour toute décision de droits.
Leurs concordances ne prouvent pas la totalité d’une compilation. Les ressources
illisibles restent inconnues ; CSP, TLS et contrôles d’origine ne sont pas réduits.

Le diagnostic HMR n’injecte aucun code dans un projet sans intégration explicite.
L’adaptateur Vite conserve les protections du serveur et de l’application. Ses
relevés sont des observations applicatives sans autorité : seules des propriétés
bornées et autorisées passent entre le cadre et le diagnostic, avec origine,
fenêtre source et identifiant de requête vérifiés. Les messages HMR bruts, chemins,
en-têtes, cookies et jetons ne sont pas relayés. Une connexion de secours hors de
la preview ne valide pas le parcours public ; les observations absentes restent
inconnues. La surveillance est bornée et ne modifie pas les données du projet.

## Journaux GitHub Actions

Les lectures MCP Actions restent liées à une connexion GitHub et au projet du
tour authentifié. Aucune URL ou identité de dépôt fournie par l’agent n’est
utilisée pour envoyer un jeton ; le couple run/job est contrôlé avant lecture.
Le lien signé de logs, obtenu uniquement depuis l’API GitHub, est limité aux
hôtes HTTPS `productionresultssa<N>.blob.core.windows.net` et n’est pas exposé.
Le stockage ne reçoit pas l’en-tête d’autorisation GitHub et ne peut pas
rediriger la requête. La règle Squid dédiée reste après les refus privés ;
aucune autorisation générale Azure Blob n’est ajoutée. Les contenus sont bornés,
non conservés et marqués non fiables. Le masquage du jeton de connexion connu
et des formats usuels de jetons ne peut pas détecter tout secret arbitraire
qu’un workflow imprimerait : les auteurs doivent préserver le masquage GitHub.

## Diagnostics des previews

Le gateway distingue ses refus des réponses de l’application par des codes
limités et des en-têtes réservés, retirés des réponses amont. Le diagnostic
Mergeron indique l’expiration du droit personnel ; une requête HEAD au site ne
prouve jamais un rôle connecté. Les pages d’erreur ne reflètent ni erreur brute,
ni secret, et le lien de retour provient uniquement de l’URL HTTPS canonique.
Les cookies des deux couches restent séparés. Le diagnostic de lancement et
d’arrêt exige les droits habituels sur le projet et l’agent, projette des champs
explicites et n’exécute aucun programme du projet. Les compteurs Docker et le
helper de volumes sont distincts des logs applicatifs non fiables ; un code
137 ne suffit pas à confirmer un OOM. Les limites de ressources sont conservées.
