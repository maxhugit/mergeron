# Tester les droits d’une autre personne

Dans **Administration → Personnes**, un administrateur connecté avec un compte
personnel peut choisir **Tester en tant que** sur une personne active.
La confirmation rappelle que les modifications sont réelles : ce n’est pas un
bac à sable. Les droits appliqués sont ceux de la personne choisie, pas ceux de
l’administrateur. Aucun mot de passe ni identité SSO de la personne n’est utilisé.

Le bandeau permanent affiche la personne simulée et l’administrateur réel.
**Revenir à mon compte** termine le test. Il reste accessible après expiration,
désactivation du compte cible ou redémarrage du serveur. Les tests durent au
maximum 15 minutes ; après expiration ils sont bloqués, sans restauration
silencieuse des droits administrateur dans une ancienne vue.

Le changement provoque un rechargement complet et une reconnexion des sockets.
Les autres onglets du même navigateur sont prévenus par un événement de stockage.
Les sockets existants de l’administrateur sont déconnectés ; les nouvelles
autorisations HTTP, Socket.IO et les notifications sont réévaluées côté serveur.
Les sessions documentaires administrateur existantes sont révoquées au début du
test. Celles créées dans le test expirent avec celui-ci et sont invalides à son
arrêt ou après redémarrage.

Le **Journal des tests de droits**, dans la page Personnes, montre les 200 derniers
événements : début, arrêt, tentatives de modifications HTTP et leurs résultats,
tentatives temps réel et écritures documentaires. Il conserve l’identité réelle
de l’administrateur et la personne simulée. Les corps des requêtes, mots de passe,
cookies et paramètres de requête ne sont jamais journalisés. Le journal n’est
pas inclus dans les archives de projets.

Le cookie HttpOnly, SameSite=Strict contient un jeton aléatoire dont seule
l’empreinte est conservée en mémoire. Il ne fonctionne qu’avec l’authentification
réelle du même administrateur, réévaluée à chaque accès. Un cookie falsifié,
expiré ou perdu après redémarrage échoue fermé ; le bouton de retour permet de
l’effacer. Le démarrage et l’arrêt exigent une requête de même origine.
Les identités de service ne peuvent pas démarrer un test et les tests imbriqués
sont refusés.

Les actions déjà acceptées et les travaux en arrière-plan ne sont pas annulés
par le retour au compte. Les historiques métier continuent d’utiliser l’acteur
effectif ; le journal de sécurité séparé identifie l’administrateur réel.
