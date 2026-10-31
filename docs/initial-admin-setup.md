# Première configuration administrateur

## Parcours fonctionnel

Une nouvelle pile Manager ouvre un assistant dans la page de connexion. Un code
obtenu avec `docker exec -it <pile>-ui node /app/scripts/setup-admin.cjs` prouve
l’accès à la console du serveur. Il expire après 15 minutes et s’échange une
seule fois contre une session limitée à la création du compte. Nom, prénom,
e-mail, identifiant et mot de passe sont saisis dans le navigateur en HTTPS.
Le compte local est créé sans connexion automatique ; la connexion ordinaire
permet ensuite de régler Codex, les services et le SSO facultatif.

Le premier visiteur n’obtient aucun droit par son ordre d’arrivée ou son e-mail.
Un proxy SSO externe continue de protéger ses propres routes ; il ne remplace
pas la preuve de contrôle du serveur. Aucun fournisseur e-mail n’est requis.

## Autorisation et stockage

Le Manager ne crée `home/.codex/webui-initial-admin.json` (mode 0600, propriétaire
applicatif) que lorsqu’il doit créer l’application, que les dossiers `home` et
`workspace` sont absents ou vides, et qu’aucun jeton interne ni trace d’adoption
n’existe. Il ne remplace aucun état existant. Ce marqueur interne contient une
identité d’installation et l’état `armed`/`closed`, pas un compte ni un secret.
L’URL publique doit être HTTPS. L’application ne déduit jamais l’autorisation du
nombre d’administrateurs et refuse l’initialisation si des personnes, des comptes
locaux ou des projets existent déjà.

Le code et la session, aléatoires sur 256 bits, ne sont conservés qu’en empreintes
SHA-256 sous `auth.initialAdminSetupSecret` dans la table `settings`. Relancer la
commande console renouvelle le code et invalide toute session précédente. Dix
échecs imposent une pause d’une minute, persistée en base. Le code n’est renvoyé
que dans le terminal `docker exec`, jamais par une API ou le logger applicatif.

L’échange crée un cookie `__Host-mergeron_setup`, `Secure`, `HttpOnly`,
`SameSite=Strict`, sans Domain et avec Path=/, limité au délai du code. Ce cookie
n’est pas une session Mergeron et ne donne accès à aucune route métier. La
création exige aussi un jeton CSRF lié à ce cookie. Les mutations exigent JSON et
l’Origin HTTPS exacte de `MERGERON_PUBLIC_URL`, indépendamment des en-têtes Host
ou forwarded fournis par l’appelant. Les réponses interdisent la mise en cache
et le transfert de référent. Aucun code n’est placé dans l’URL ou localStorage.
Les pages HTML applicatives refusent aussi l’intégration en iframe externe pour
protéger l’assistant et la connexion contre la superposition trompeuse de boutons.

## Contrats HTTP

Ces trois routes uniquement sont publiques, y compris pendant la vérification
de session du navigateur ; aucun accès aux données métier n’est élargi.

| Route | Contrat |
|---|---|
| `GET /api/auth/setup/status` | `required`, `authorized`, nom public du conteneur ; `csrfToken` uniquement avec une session d’initialisation valide. Ni code ni empreinte. |
| `POST /api/auth/setup/verify` | Corps `{code}` ; code invalide/expiré/bloqué : 401 ; renvoie `authorized`, `csrfToken` et le cookie restreint. |
| `POST /api/auth/setup/complete` | Prénom, nom, e-mail, identifiant, mot de passe, confirmation, `csrfToken` ; nécessite le cookie ; champs inconnus refusés, rôle imposé à administrator. Renvoie `{completed:true}` et efface le cookie. |

Aucune route n’émet, ne renouvelle ou ne réarme un code. Les identifiants suivent
la validation locale, le mot de passe comporte 12 à 1024 caractères et utilise
Argon2id avec les paramètres locaux existants. Le contrôle de session est refait
après le calcul du hash. Une transaction SQLite `IMMEDIATE` crée la personne,
ses identifiants et la fermeture persistante : une seule soumission concurrente
réussit. Les journaux ne contiennent que l’événement et l’ID de la personne.

## Interruption, mises à jour et restauration

Le marqueur est fermé et synchronisé sur disque **avant** le commit SQLite : une
erreur d’écriture ou un crash échoue fermé, sans premier compte partiel. Si le
processus s’arrête entre cette fermeture et le commit, seul l’opérateur peut
réarmer l’installation vide avec `setup-admin.cjs --retry-interrupted`. Cette
option exige l’autorisation Manager d’origine et refuse une base déjà terminée
ou contenant des personnes, comptes ou projets. Elle ne réinitialise pas les
comptes existants ; l’ancien outil de récupération reste disponible séparément.

Une mise à jour de l’application seule ne crée pas de marqueur et ne change
aucun compte dev/prod. Supprimer les administrateurs ou restaurer une ancienne
base ne rouvre pas l’assistant tant que le marqueur fermé est conservé. Une
restauration volontaire de **tout** l’état datant d’avant la création du premier
compte peut restaurer aussi le marqueur armé : il faut conserver la fermeture ou
traiter cette opération comme une nouvelle initialisation contrôlée. Les
sauvegardes officielles nécessitant déjà un administrateur, elles sont prises
après cette étape. Ne pas supprimer le marqueur pour contourner un échec.

Les espaces d’exécution d’agents masquent le marqueur comme la base applicative,
y compris en accès complet. La console de l’hôte reste une autorité privilégiée ;
ces garanties ne protègent pas d’un administrateur Docker compromis.
