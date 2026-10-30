# Raccorder le réseau et le SSO

Cette page complète [Installer Mergeron](installation.md). Elle ne propose pas
une autre méthode d’installation. Le Manager reste le propriétaire des
conteneurs Mergeron ; votre proxy HTTPS, votre DNS et votre éventuel fournisseur
d’identité sont administrés séparément.

## Réseau et proxy HTTPS

1. Choisir un domaine et préparer un certificat HTTPS valide.
2. Choisir un réseau Docker externe existant et le déclarer dans
   `MERGERON_PROXY_NETWORK`.
3. Raccorder votre proxy à ce réseau de manière persistante.
4. Faire suivre le domaine vers **`mergeron-ingress:8080`** ; adapter le préfixe
   si votre pile porte un autre nom.
5. Garder le backend, le filtre sortant et le Manager privés.

Le proxy peut être celui de votre choix. Il doit conserver le `Host` public,
y compris un éventuel port HTTPS non standard, transmettre le protocole
d’origine et les en-têtes proxy, accepter les WebSocket et laisser passer les
réponses en continu sans mise en tampon excessive. Prévoir des délais adaptés
aux échanges longs.

Ne pas cibler une IP de conteneur éphémère ni publier les ports 8172, 8173 ou
3128 sur Internet. Le Manager ne configure pas automatiquement un proxy situé
sur un autre hôte : ce cas exige une liaison privée maîtrisée, pas une ouverture
du backend sur `0.0.0.0`.

La sortie HTTP(S) de l’application passe par le filtre livré dans Mergeron.
Autoriser uniquement les domaines nécessaires aux fonctions utilisées.
Les [prévisualisations de projets](previsualisations-agents.md) et le
[navigateur distant](navigateur-annote.md) ont leurs propres règles réseau.

## Authentification sans SSO

Le mode standard est `MERGERON_AUTH_MODE=native` : compte et mot de passe
Mergeron, aucun fournisseur extérieur imposé. Aucun compte administrateur par
défaut ni accès anonyme n’est créé. La création du premier administrateur est
une étape explicite du [guide d’installation](installation.md#4-créer-le-premier-administrateur).

## SSO facultatif

Mergeron prend en charge **OpenID Connect (OIDC)**. Choisir un fournisseur
compatible, créer son client et enregistrer la redirection exacte :

```text
https://mergeron.example.com/api/auth/oidc/callback
```

Dans les réglages d’authentification Mergeron, renseigner l’émetteur OIDC,
l’identifiant et le secret du client, cette redirection et les portées
`openid profile email`. Tester la connexion avant de désactiver la connexion
locale et conserver un moyen de récupération administrateur.

Le mode ingress reste `native` pour ce SSO : il ne dépend pas du nom du
fournisseur. Les autres protocoles d’annuaire ou de fédération nécessitent une
passerelle OIDC ; des en-têtes envoyés par un navigateur ne sont pas une identité
de confiance. Une personne administrateur doit être liée explicitement au sujet
stable vérifié, pas simplement à une adresse e-mail.

Le filtre sortant doit autoriser les domaines de découverte, de signature et
d’échange du code du fournisseur. Un service privé exige une autorisation
ciblée ; ne pas désactiver le refus général des réseaux privés.

Le détail de la gestion des comptes se trouve dans
[Configuration des intégrations](configuration-integrations.md).

## Recette avant exposition

- Certificat valide, connexion et déconnexion réussies.
- Personne non connectée ou non autorisée refusée ; faux en-têtes sans effet.
- Conversation en continu, reconnexion WebSocket et téléchargement de fichier.
- Seul l’ingress raccordé au réseau du proxy ; aucun port privé publié.
- Même état persistant après redémarrage, sans conteneur créé en double.
- Options facultatives testées seulement si elles ont été activées.

Les variables de l’installateur servent à créer les ressources manquantes.
Elles ne remplacent pas les fichiers de configuration déjà présents.
