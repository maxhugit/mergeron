# Transcription locale de fichiers audio et vidéo

Le service facultatif `mergeron-transcription` est distinct de la dictée au micro.
Il transcrit la piste audio, détecte sa langue dominante et produit des segments
horodatés. Avec des modèles locaux de diarisation, il ajoute `SPEAKER_00`,
`SPEAKER_01`, etc. Ces repères anonymes ne reconnaissent pas l’identité des
personnes. La qualité et les chevauchements de voix peuvent affecter l’attribution.

## Utilisation et limites

Ouvrir un audio ou une vidéo dans l’explorateur, puis choisir **Extraire l’audio**,
**Transcrire** ou **Audio + transcription**. L’extraction seule ne charge aucun
modèle de reconnaissance vocale. Elle convertit la première piste audio en MP3
stéréo 96 kbit/s, 44,1 kHz ; le fichier vidéo original reste inchangé.
L’interface indique l’attente du service, le décodage, le chargement du modèle,
la transcription et la séparation éventuelle des locuteurs. Télécharger ensuite
le MP3 extrait et, si demandée, la transcription en TXT, SRT ou JSON. Annuler interrompt le traitement et supprime son
résultat. Un échec de diarisation conserve le texte avec un avertissement explicite.

Limites : 128 Mio et deux heures par fichier, une tâche exécutée à la fois,
quatre en attente/en traitement au total, dont deux par personne. Les résultats
sont privés à la personne authentifiée, séparés des sessions d’usurpation
administrateur ; les identités techniques ne peuvent pas utiliser ces API.
Le plafond de conservation est de 100 résultats par personne et 1 000 au total.
Supprimer un ancien résultat libère une place : aucun résultat existant n’est
supprimé arbitrairement pour accepter une demande.

## Demande à l’agent et publication dans un livrable

Ajouter la vidéo comme document d’un livrable du projet, puis demander par exemple :
« Extrais la piste audio de cette vidéo et ajoute le MP3 à ce livrable ».
L’agent dispose de `project_media_read` (service, documents et versions, état d’une
tâche) et `project_media_manage` (démarrer, annuler, publier). Les modes sont
`extract`, `transcribe` et `both`. Aucun chemin libre ni URL distante n’est accepté.
Le dépôt initial dans un livrable reste soumis à sa limite existante de 100 Mio.
Le MP3 à 96 kbit/s reste sous cette limite pour deux heures d’audio.
Le projet et la conversation sont liés par le serveur ; le document est lu depuis
sa version immuable et son empreinte est revérifiée à la copie.

L’agent doit annoncer une réussite complète uniquement lorsque l’état est `ready`.
Avec le mode combiné, un échec de reconnaissance conserve le MP3 déjà extrait :
l’état `partial` indique explicitement que seule la piste audio est prête, sans
annoncer de réussite de la transcription.
La publication ajoute un nouveau document MP3 au livrable choisi, via le mécanisme
normal de versions, sans écraser un fichier existant. Elle nécessite une demande
humaine explicite et un tour administrateur avec écriture. Les clés `requestId`
restent identiques lors d’une vérification/reprise ; une publication incertaine
nécessite une inspection, pas une nouvelle tentative sous un autre identifiant.
Les droits du tour sont revérifiés au moment de la publication effective.
Les tâches sont privées à leur personne, leur projet et leur conversation ; une
conversation ne peut pas consulter ou annuler le travail d’un autre agent.

Les fichiers audio privés occupent au maximum 512 Mio par personne et 2 Gio au
total, avec réservation d’espace pour les tâches déjà acceptées. Ils sont conservés
dans `transcription-media/<id>/audio.mp3` à côté de la base SQLite pendant la même
durée que les résultats. Ces MP3 privés ne sont pas inclus dans une sauvegarde
limitée à la base et à la configuration. Une restauration sans ces fichiers est
détectée au redémarrage : Mergeron les signale manquants au lieu de les annoncer
comme prêts. La taille et l’empreinte SHA-256 du téléchargement depuis
le worker sont vérifiées avant de présenter le fichier comme prêt. Suppression
et rétention nettoient également ces fichiers. Une copie publiée dans un livrable
suit ensuite la conservation et les sauvegardes propres à ce livrable.

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
minutes. Le conteneur est limité à **6 Gio de RAM, 4 CPU et 128 processus**, avec
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
Le runtime Python 3.12 sur base Wolfi conserve les métadonnées de ses paquets pour le scan de sécurité.
Son paquet [FFmpeg 9](https://github.com/wolfi-dev/os/blob/main/ffmpeg-9.0.yaml)
fournit les bibliothèques partagées nécessaires à
[TorchCodec 0.17](https://github.com/meta-pytorch/torchcodec/blob/v0.17.0/README.md).
PyTorch reste en version CPU 2.11 ; `pip check` vérifie les contraintes de
l’environnement avant sa validation sur de vrais fichiers synthétiques. Le programme
d’installation pip est ensuite désinstallé du runtime : le service utilise
uniquement les dépendances et les modèles déjà présents dans son image.

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

Un test local utilise FFmpeg sur une véritable vidéo synthétique et vérifie le MP3
avec FFprobe, sans modèle ni compte. La CI construit l’image CPU, la scanne selon la politique HIGH/CRITICAL existante,
puis transcrit deux voix synthétiques, anglaise et française, dans le vrai worker
avec `--network none`, sans port ni compte. Elle vérifie texte, langue, segments
et suppression des tâches. Les étiquettes mobiles ne sont promues qu’après cette
validation et les checks source. Les modèles Pyannote soumis à acceptation ne
sont pas téléchargés par la CI : leur inférence doit être validée séparément,
avec modèles autorisés et enregistrements de test consentis.

### Installation préalable et validation de la diarisation

La dépendance Pyannote est déjà présente dans l’image ; ses poids ne le sont pas.
L’activation exige une installation préalable des modèles, distincte du traitement
des médias. Après acceptation des conditions Community-1 avec votre compte,
utiliser un environnement d’installation avec `huggingface_hub`, un jeton de
lecture autorisé fourni via `HF_TOKEN` et la commande suivante :

```sh
python3 scripts/install-diarization-models.py \
  --revision 3533c8cf8e369892e6b79ff1bf80f7b0286a54ee \
  --output /chemin/vers/etat/config/transcription-diarization
```

Le script refuse les références mobiles et les destinations déjà existantes.
Il conserve la révision et les empreintes SHA-256 dans `mergeron-models.json`,
supprime les métadonnées temporaires de téléchargement et ne conserve aucun jeton.
Le jeton est réservé à cet environnement d’installation : ne pas le configurer
sur le Manager ni sur le worker. L’installation ne lit aucun média. Cette
commande prépare les poids ; elle ne constitue pas une validation acoustique.
Le chargement et une première inférence doivent ensuite être vérifiés avec
le worker, son montage en lecture seule et son réseau interne sans accès externe.

Activer ensuite `MERGERON_TRANSCRIPTION_DIARIZATION=true` sur le Manager,
puis recréer le service facultatif sans tâche ni bail actif pour appliquer
le montage. Une simple modification de la variable ne modifie pas un conteneur
existant. Conserver son image validée et ses limites d’isolation. Ne pas remplacer
une stack ou ses données pour ajouter ce montage.

Les résultats utilisent désormais `SPEAKER_00`, `SPEAKER_01`, etc., dans l’ordre
de première apparition des voix dans l’enregistrement. Un même repère ne désigne
pas nécessairement la même personne dans un autre enregistrement. L’analyse
utilise les caractéristiques acoustiques ; elle ne déduit pas les voix du dialogue.
Le nombre de locuteurs est une estimation issue de la diarisation, y compris
les voix dont aucun mot ne peut être attribué avec assez de certitude.

Le rapprochement s’effectue avec les horaires des mots. Il sépare les passages
quand le locuteur change ; il ne devine pas comment découper un mot qui chevauche
une frontière. Les mots couvrant plusieurs voix, trop peu couverts par une voix
ou issus d’un tour acoustique de moins de 0,5 seconde restent sans attribution.
Ces seuils temporels sont des heuristiques conservatrices, pas un score de
confiance biométrique. Les avertissements structurés signalent les chevauchements,
les interventions courtes, les attributions incertaines et l’absence de voix
détectée. Whisper peut omettre l’une des voix simultanées : les avertissements
ne signifient pas que toutes les paroles ont été transcrites.

Le téléchargement TXT contient l’état, le nombre estimé de locuteurs, les
avertissements et les passages avec horaires et étiquettes. Les passages sans
attribution sont explicites. Il crée un téléchargement ; il n’enregistre ni ne
remplace automatiquement un document d’un livrable. Les anciens résultats et TXT
ne sont pas recalculés : relancer une nouvelle tâche sur le MP4 d’origine, vérifier
le nouveau résultat puis choisir explicitement de le publier sous un nouveau nom.
Les étiquettes antérieurement déduites du dialogue ne sont pas une preuve d’analyse
vocale et ne doivent pas servir de référence acoustique.

Avant de déclarer la diarisation validée, contrôler des enregistrements autorisés
avec une, deux et trois voix connues, des échanges courts et des paroles simultanées.
Conserver une référence horodatée attribuée par écoute, indépendante du texte et
de la sortie du modèle. Comparer le nombre estimé de voix, la cohérence d’un même
repère au fil de l’enregistrement, les frontières de changement et les passages
laissés sans attribution. Noter séparément les erreurs de transcription et
les erreurs de diarisation. Les tests unitaires de rapprochement et les voix
synthétiques de la CI ne remplacent pas cette validation acoustique et humaine.
