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
