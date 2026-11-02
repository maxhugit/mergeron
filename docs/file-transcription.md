# Transcription locale de fichiers audio et vidéo

Le service facultatif `mergeron-transcription` est distinct de la dictée au micro.
Il transcrit la piste audio, détecte sa langue dominante et produit des segments
horodatés. Avec des modèles locaux de diarisation, il ajoute « Locuteur 1 »,
« Locuteur 2 », etc. Ces repères anonymes ne reconnaissent pas l’identité des
personnes. La qualité et les chevauchements de voix peuvent affecter l’attribution.

## Utilisation et limites

Ouvrir un audio ou une vidéo dans l’explorateur, puis choisir **Transcrire**.
L’interface indique l’attente du service, le décodage, le chargement du modèle,
la transcription et la séparation éventuelle des locuteurs. Télécharger ensuite
le résultat en TXT, SRT ou JSON. Annuler interrompt le traitement et supprime son
résultat. Un échec de diarisation conserve le texte avec un avertissement explicite.

Limites : 128 Mio et deux heures par fichier, une tâche exécutée à la fois,
quatre en attente/en traitement au total, dont deux par personne. Les résultats
sont privés à la personne authentifiée, séparés des sessions d’usurpation
administrateur ; les identités techniques ne peuvent pas utiliser ces API.
Le plafond de conservation est de 100 résultats par personne et 1 000 au total.
Supprimer un ancien résultat libère une place : aucun résultat existant n’est
supprimé arbitrairement pour accepter une demande.

## Activation et ressources

Le service est **désactivé par défaut** et ne modifie pas la dictée CLI/API.
Après publication de son image, configurer le Manager :

```dotenv
MERGERON_TRANSCRIPTION_ENABLED=true
MERGERON_TRANSCRIPTION_IDLE_SECONDS=300
MERGERON_TRANSCRIPTION_DIARIZATION=false
```

Les modèles Compose et Manager Unraid exposent ces options. Recréer uniquement
le Manager selon la procédure habituelle pour appliquer ses variables. Aucun
port supplémentaire n’est nécessaire. L’image est
`ghcr.io/maxhugit/mergeron-transcription:edge` en Dev et `:latest` en production.
Ouvrir l’inventaire ne télécharge ni ne démarre le service.

À la première transcription, le Manager télécharge si nécessaire l’image et crée
`<préfixe-de-stack>-transcription`. Le premier démarrage peut prendre plusieurs
minutes. Le conteneur est limité à **6 Gio de RAM, 2 CPU et 128 processus**, avec
1 Gio de temporaire en tmpfs. Prévoir aussi l’espace disque de l’image, contenant
les bibliothèques CPU et les poids. L’image initiale cible Linux amd64. Aucun GPU n’est nécessaire. Le service
s’arrête après le délai d’inactivité ; les tâches actives renouvellent leur bail.

L’infrastructure et l’inventaire des composants affichent le service activé.
Le Manager consulte les métadonnées d’image toutes les cinq minutes, même arrêté.
Une différence d’index OCI ne prouve pas à elle seule une nouvelle image exécutable.
Le remplacement n’est **pas automatique** : cette première version signale la
disponibilité ; les transactions de mise à jour du cœur de Mergeron ne remplacent
pas le conteneur facultatif. Planifier sa maintenance sans tâche active.

## Modèles et locuteurs

La transcription et la langue fonctionnent sans compte externe au runtime.
L’image embarque [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper) et le
modèle Small converti, révision `536b0662742c02347bc0e980a01041f333bce120`.

Pour les locuteurs, préparer une copie **complète et fonctionnant hors ligne** de
[Pyannote Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1),
après examen et acceptation de ses conditions d’accès et de sa licence. Suivre
ses instructions officielles de fonctionnement hors ligne. Mergeron n’accepte
pas ces conditions au nom de l’utilisateur.

Placer le modèle dans `config/transcription-diarization` sous la racine d’état,
avec `config.yaml` et tous ses poids, lisibles par UID/GID `11003:11003`.
Les répertoires de configuration et des modèles ne doivent pas être des liens
symboliques. Activer `MERGERON_TRANSCRIPTION_DIARIZATION=true` avant la création
du service : le Manager monte uniquement ce répertoire, en lecture seule.
Ne pas y placer de jeton Hugging Face, compte Codex ni clé API. Si le conteneur
existe avec un ancien montage, planifier sa recréation avant de modifier l’option.
Sans modèle, le résultat indique explicitement la séparation indisponible ; un
modèle incomplet produit un échec de cette étape sans remplacer le texte.

## Isolation, données et reprise

Le worker utilise le réseau Docker **interne** de la stack. Aucun port publié,
socket Docker, workspace monté ou accès aux données de production. Racine en
lecture seule, UID non privilégié, capacités retirées, `no-new-privileges` et
seccomp Docker restent actifs. FFmpeg refuse les protocoles réseau pour décoder
le fichier. Les médias ne sont pas envoyés à un prestataire de transcription.

Le jeton aléatoire interne est transmis au backend uniquement sur le socket privé,
jamais au navigateur, dans une URL ou dans l’inventaire. Les requêtes du worker
et le contenu des transcriptions ne sont pas journalisés.

Les copies temporaires dans l’application et le worker sont supprimées après
réussite, échec ou annulation. Les résultats et métadonnées restent dans SQLite,
table `transcription_jobs`, pendant 30 jours au maximum avec rétention horaire.
Ils font partie de la sauvegarde de la base : protéger ces sauvegardes comme les
autres données utilisateur. Aucun fichier source n’est modifié. Au redémarrage,
les tâches inachevées deviennent « interrompues » et leurs temporaires connus
sont nettoyés ; elles ne sont pas relancées sans demande.

## Validation et publication

Les tests locaux couvrent personnes et sessions séparées, quotas, uploads
tronqués, redémarrage, validation des résultats, baux, locuteurs anonymes et API
privée. Les essais visuels utilisent des résultats synthétiques et ne prouvent
pas une inférence réelle.

La CI construit l’image CPU, la scanne selon la politique HIGH/CRITICAL existante,
puis transcrit deux voix synthétiques, anglaise et française, dans le vrai worker
avec `--network none`, sans port ni compte. Elle vérifie texte, langue, segments
et suppression des tâches. Les étiquettes mobiles ne sont promues qu’après cette
validation et les checks source. Les modèles Pyannote soumis à acceptation ne
sont pas téléchargés par la CI : leur inférence doit être validée séparément,
avec modèles autorisés et enregistrements de test consentis.
