# Navigateur distant en direct

Le bouton Navigateur ouvre un onglet à côté de Conversation. Sur ordinateur,
« Côte à côte » conserve la conversation à gauche et le navigateur à droite.
Chaque clic crée une nouvelle vue (cinq maximum par conversation), sans onglets
imbriqués. Sur grand écran, le côte-à-côte est activé par défaut ; sur mobile,
la vue utilise toute la largeur. Ouvrir ou fermer l’explorateur ne masque pas
le navigateur. Les commandes de disposition et d’effacement de session sont des
icônes dans la barre d’adresse.

L’onglet Navigateur du projet permet à un administrateur de choisir la page
d’accueil (https://www.google.com par défaut), le côte-à-côte initial et
l’autorisation des fenêtres secondaires. Ces réglages concernent les nouvelles
sessions. Chaque vue possède son propre contexte isolé. Une fenêtre secondaire
est affichée dans la même vue et conserve les cookies de son opener ; sa fermeture
rend la page d’origine. Les limites de pages et de réseau restent inchangées.
Les boîtes de dialogue natives Chromium/WebAuthn (par exemple le QR code de
connexion par passkey sur téléphone) ne font pas partie des pixels de la page et
ne sont pas prises en charge par ce flux. Ne pas confondre cette limite avec les
fenêtres web d’authentification, désormais conservées.
Le navigateur utilise toujours le runtime Chromium isolé et son proxy public :
aucun port CDP, WebSocket de contrôle ou accès réseau privé n’est exposé au client.

Le flux JPEG continu passe par un POST authentifié vers
`/api/browser/:threadId/live`. Les interactions souris, molette, clavier et le
redimensionnement passent par des requêtes bornées vers `input`. Un jeton de
contrôle éphémère lie les actions à la vue ; la page et ses dimensions sont
revérifiées avant application. Les actions ne sont jamais rejouées après erreur.
Les pixels sont dessinés dans un canvas, sans exécuter le HTML du site côté client.

Une seule vue contrôle une session personne/conversation à la fois. Une seconde
vue doit explicitement « Prendre le contrôle ». « Libérer le contrôle », masquer
l’onglet, quitter la conversation ou fermer la page arrête le flux et relâche les
boutons et modificateurs. Les pages restent temporairement ouvertes dans la
session isolée ; « Effacer la session » les ferme. Le flux renouvelle son
authentification au plus tard toutes les cinq minutes, avec revérification des
droits pendant sa diffusion. Les restrictions administrateur existantes restent
inchangées, y compris lors d’un test de droits.

Le flux affiché à l’utilisateur peut contenir des saisies non masquées. Il n’est
ni enregistré ni ajouté aux messages. « Pointer un élément » interrompt ce flux
et demande une capture distincte, sans cache rose sur les champs. Cette capture
peut donc contenir leur texte : il faut la vérifier avant de l’envoyer. Les champs
de mot de passe gardent leur affichage natif du site. Seule la capture commentée
peut être ajoutée au brouillon, puis
envoyée manuellement à l’agent. Les mécanismes de contrôle des captures périmées
et de traitement des pages comme contenu non fiable restent en place.

Limites : ce n’est pas le navigateur personnel de l’utilisateur, ni un lecteur
audio/vidéo. Le débit est plafonné à environ 15 images par seconde avec
contre-pression, une résolution maximale de 1920 × 1200 et cinq pages par
session. Seul le collage de texte explicite est transmis ; aucun accès implicite
au presse-papiers ou transfert de fichiers n’est ajouté.
