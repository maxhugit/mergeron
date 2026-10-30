# Configurer Mergeron après l’installation

Commencer par [Installer Mergeron](installation.md). Les intégrations ci-dessous
sont facultatives : elles n’imposent ni fournisseur SSO, ni serveur externe,
ni environnement particulier.

## Administration et rôles

Les paramètres de l’en-tête ouvrent les rubriques du serveur, des personnes,
du moteur d’agents, du chat, des fichiers, de la sécurité et des intégrations.
Sur mobile, elles sont accessibles par le menu de navigation.

Les réglages d’administration et les exécutions serveur sont réservés aux
administrateurs. Les droits des personnes et des participants sont vérifiés
côté serveur ; masquer un bouton n’est pas une protection suffisante.
Les personnes standard n’obtiennent aucun accès administrateur en présentant
simplement la même adresse e-mail qu’une autre personne.

Les explorateurs et terminaux d’un projet ne donnent pas un droit sur tout
l’hôte. Limiter les dossiers exposés et les permissions des connexions.
Voir les [droits des projets](droits-acces-projets.md).

### Initialisation et récupération administrateur

Le premier compte local se crée depuis l’hôte selon
[l’étape dédiée du guide](installation.md#4-créer-le-premier-administrateur).
L’outil livré `scripts/provision-person.cjs` réutilise les validations du serveur
et crée atomiquement la fiche et son compte. Il ne crée ni mot de passe par
défaut ni page publique d’inscription.

En cas de récupération, un administrateur de l’hôte peut utiliser ce même outil
avec un fichier JSON privé, après sauvegarde de la base. Ne pas placer le mot
de passe dans un argument de commande, un journal ou Git. Une fiche ou une
liaison déjà utilisée n’est pas écrasée pour contourner un conflit.

Pour un compte SSO administrateur, renseigner explicitement `identitySubject`
avec le sujet stable vérifié du fournisseur, sans `localAccount`. Vérifier
humainement cette identité : une simple égalité d’e-mail ne suffit pas.
Tester une relève administrateur avant de retirer un accès existant.

## Authentification : compte local et SSO OIDC

Le compte local est activé par défaut ; OIDC et sa redirection automatique
restent désactivés tant qu’un administrateur ne les configure pas.
Le mode ingress reste `native`, y compris avec un fournisseur OIDC.

Dans les réglages d’authentification, renseigner l’émetteur, l’identifiant et le
secret du client, l’URI de rappel et les portées. La redirection est :

```text
https://mergeron.example.com/api/auth/oidc/callback
```

Le serveur contrôle la découverte OIDC et les points de terminaison avant
activation. Le secret est conservé dans la configuration privée de l’application,
pas renvoyé au navigateur. Aucun fournisseur particulier n’est requis.
Voir le [raccordement SSO](installation-portable.md#sso-facultatif).

Après configuration, tester connexion, déconnexion, refus d’un compte inconnu
et récupération avant d’ouvrir largement le service. Ne pas faire confiance
aux en-têtes d’identité directement fournis par un navigateur.

## Moteur d’agents et chat

Installer le [CLI validé par le Manager](operations/managed-codex-runtime.md)
depuis les réglages du moteur, puis configurer son authentification.
Le moteur actuellement intégré est Codex. Les paramètres et l’authentification
restent dans le stockage persistant de Mergeron.

Le chat simple possède sa propre configuration d’accès. Si une clé est utilisée,
la conserver uniquement dans le stockage privé prévu, jamais dans Git ou une
capture. Vérifier une réponse et le rechargement d’une conversation après
redémarrage.

## Connexions et outils des projets

Configurer seulement les connexions nécessaires au projet, avec un périmètre
et des droits minimaux. Une connexion configurée ne donne pas automatiquement
à un agent l’autorisation d’écrire ou de publier.

Les sélections MCP et les applications disponibles se règlent par projet.
Les outils refusés dans la configuration globale ne peuvent pas être réactivés
par un participant. Vérifier les effets sur les nouvelles conversations et
renouveler une autorisation expirée depuis l’interface, sans copier le secret
dans une conversation.

Voir le [contexte et les outils des agents](contexte-et-outils-agents.md), les
[espaces de travail](workspaces-projets.md) et le guide intégré des fonctionnalités.

## Documents et services facultatifs

Les PDF disposent d’une visionneuse intégrée. Pour l’édition de documents,
configurer l’intégration proposée par Mergeron depuis l’administration et
tester un fichier de test. Ses téléchargements et sauvegardes utilisent les
contrôles signés prévus ; ne pas exposer un jeton de service dans le navigateur
ni ajouter un contrôle interactif incompatible devant ses rappels.

Le [navigateur distant](navigateur-annote.md) et les
[environnements de test](previsualisations-agents.md) s’activent séparément.
Leur absence n’empêche pas la première connexion à Mergeron.
