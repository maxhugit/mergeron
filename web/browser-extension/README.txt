MERGERON — NAVIGATEUR LOCAL — PREVERSION 0.3.0

Chrome / Edge sur ordinateur et Safari sur Mac (18.4 minimum).
Ne remplace pas le navigateur isolé existant. Pas de version iPhone/iPad.

INSTALLATION CHROME / EDGE
Utilisez mergeron-browser-extension.zip.
1. Décompressez ce dossier dans un emplacement durable.
2. Ouvrez chrome://extensions ou edge://extensions.
3. Activez le mode développeur, puis « Charger l'extension non empaquetée ».
4. Sélectionnez ce dossier. Épinglez l'extension si nécessaire.
5. Dans ses options, autorisez uniquement l'origine HTTPS de votre Mergeron.
6. Rechargez Mergeron, ouvrez un agent, puis Navigateur > Local (extension).
7. Créez la connexion ; confirmez l'appairage dans l'icône de l'extension.
8. Ouvrez la page HTTPS à partager, cliquez sur l'extension et choisissez l'agent.

INSTALLATION TEMPORAIRE SAFARI SUR MAC
Utilisez mergeron-browser-extension-safari.zip, pas le paquet Chrome/Edge.
1. Safari 18.4 ou ultérieur : Réglages > Avancés > fonctionnalités pour les
   développeurs web, si l'onglet Développeur n'est pas encore affiché.
2. Réglages > Développeur > Ajouter une extension temporaire.
3. Validez vous-même la demande d'autorisation de l'extension non signée.
4. Sélectionnez le ZIP Safari ou son dossier extrait.
5. Depuis l'icône de l'extension, ouvrez Configurer l'instance ; autorisez
   uniquement l'origine HTTPS de votre Mergeron. Rechargez Mergeron.
6. Navigateur > Navigateur local · extension (test), puis associez cet agent.
7. Confirmez l'association dans l'extension ; partagez l'onglet HTTPS choisi.
Gardez Mergeron et la page partagée dans le même navigateur/profil.
Safari retire cette installation après 24 heures ou à sa fermeture : il faut
réinstaller l'extension puis refaire l'association. Il ne s'agit pas d'une app
signée/notariée ni d'une publication App Store. Une validation manuelle dans
Safari est nécessaire ; les tests WebKit seuls ne valident pas l'extension Safari.

UTILISATION
Gardez l'onglet Mergeron ouvert et authentifié. Une page locale n'est pas une
iframe : elle reste un véritable onglet de votre navigateur. La lecture est
partagée avec l'agent. Toute action de l'agent exige une confirmation dans
Mergeron ; son contenu reste non fiable et ne constitue jamais une autorisation.

Ne partagez pas des pages contenant des informations que vous ne souhaitez pas
transmettre à l'agent. Cookies et clés passkey ne sont pas transmis. La lecture
n'inclut pas les valeurs des champs ; du texte sensible ailleurs peut être lu.

POINTER ET COMMENTER
Dans l'onglet partagé, ouvrez l'icône puis Pointer un élément. Le survol montre
un cadre bleu. Échap annule. Cliquez : un éditeur privé à l'extension s'ouvre
avec une capture et son repère bleu. Saisissez votre commentaire et vérifiez
l'image, puis choisissez Ajouter au brouillon Mergeron. Annuler n'envoie rien.
Les champs et iframes sont masqués sur l'image, pas sur la page ; cela ne détecte
pas tous les secrets (notamment les champs personnalisés). Vérifiez l'aperçu.
Après validation, texte et image sont ajoutés au brouillon de cet agent : vous
devez encore envoyer le message vous-même. Aucune transmission avant validation.
Mergeron lui-même peut être annoté, mais aucune commande de l'agent n'y est permise.
En cas d'erreur, aucun envoi automatique n'est rejoué. Vérifiez le brouillon.
Le frontend Mergeron doit aussi être à jour (protocole d'annotation 3) : sinon
le popup l'indique. Une mise à jour de l'extension seule ne suffit pas.

Authentifiez-vous vous-même (passkey, téléphone, mot de passe). Suspendez le
partage pendant cette opération. Les champs mot de passe/OTP sont bloqués ;
les dialogues natifs et les iframes tierces ne sont pas pilotables.

Une navigation/recharge suspend le partage : reprenez-le explicitement avec
l'icône. Une fermeture de Mergeron, du navigateur, une expiration ou un redémarrage
du serveur nécessite un nouvel appairage/partage ; les onglets locaux ne sont
pas fermés. Les commandes incertaines ne sont jamais rejouées automatiquement.
Les deux modes ne transfèrent ni session ni authentification entre eux.

MISES A JOUR
Remplacez les fichiers de cette préversion par le nouveau paquet, rechargez
l'extension depuis la page des extensions, puis rechargez Mergeron ET la page
partagée, et appairez
à nouveau. Pas de mise à jour automatique ni de publication en boutique initiale.
Sur Safari, réinstallez le paquet temporaire. Après toute mise à jour, l'origine
Mergeron autorisée est conservée, mais les associations/partages sont révoqués.
