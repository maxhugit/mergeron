# Modèles de diarisation embarqués

Ce dossier contient les modèles Community-1 utilisés par Mergeron pour distinguer
les voix localement. Les poids et la configuration proviennent du
[dépôt officiel Pyannote](https://huggingface.co/pyannote/speaker-diarization-community-1/tree/3533c8cf8e369892e6b79ff1bf80f7b0286a54ee),
révision `3533c8cf8e369892e6b79ff1bf80f7b0286a54ee`.
Ils sont versionnés directement dans Git ; Git LFS et un compte Hugging Face ne
sont pas nécessaires pour utiliser ce bundle dans Mergeron.

Les modèles sont distribués sous **CC BY 4.0**, distinctement du code Mergeron.
Le [texte intégral de la licence](LICENSE.txt) s’applique à ce bundle.
L’attribution est conservée dans la [fiche originale du modèle](MODEL_CARD.md),
la [notice du modèle d’empreintes vocales](embedding/README.md) et la
[notice PLDA](plda/README.md). Auteurs : Pyannote et les contributeurs cités dans
ces notices, notamment les équipes WeSpeaker et BUT Speech@FIT.
Aucune approbation de Mergeron par ces auteurs n’est revendiquée.

Les poids n’ont pas été réentraînés ni convertis. Les espaces en fin de ligne
des notices, de la licence et du YAML sont normalisés, sans modification des
paramètres du modèle. Mergeron ajoute cette
notice, la licence, les règles Git et le manifeste d’intégrité
`mergeron-models.json`. Les fichiers d’attributs LFS et la démonstration animée du
dépôt d’origine ne sont pas inclus. `model_bundle.py` vérifie les empreintes et la
révision lors de la construction et au démarrage du worker.

Le Dockerfile copie ce dossier dans `/models/diarization`. Le Manager utilise
cette copie en lecture seule avec le mode `bundled`, sans montage de modèles
sur l’hôte, sans jeton et sans téléchargement lors d’une transcription.
