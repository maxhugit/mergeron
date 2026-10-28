# Navigateur distant en direct

Le bouton Navigateur ouvre un onglet à côté de Conversation. Sur ordinateur,
« Côte à côte » conserve la conversation à gauche et le navigateur à droite.
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
et demande une capture distincte dont les champs de saisie sont masqués.
Seule cette capture masquée et commentée peut être ajoutée au brouillon, puis
envoyée manuellement à l’agent. Les mécanismes de contrôle des captures périmées
et de traitement des pages comme contenu non fiable restent en place.

Limites : ce n’est pas le navigateur personnel de l’utilisateur, ni un lecteur
audio/vidéo. Le débit est plafonné à environ 15 images par seconde avec
contre-pression, une résolution maximale de 1920 × 1200 et cinq pages par
session. Seul le collage de texte explicite est transmis ; aucun accès implicite
au presse-papiers ou transfert de fichiers n’est ajouté.
