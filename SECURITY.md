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
