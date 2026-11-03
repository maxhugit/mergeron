/** Role profiles are mission text, never native permission grants. */
import { z } from 'zod';
export const teamProfilesSchema = z
  .array(
    z.strictObject({
      key: z.string().regex(/^[\w-]{1,64}$/),
      role: z.string().trim().min(1).max(120),
      instructions: z.string().trim().min(1).max(6000),
      dependencies: z
        .array(z.string().regex(/^[\w-]{1,64}$/))
        .max(12)
        .default([]),
    }),
  )
  .min(1)
  .max(12);
export const defaultTeamProfiles = [
  {
    key: 'sources',
    role: 'Sources',
    instructions:
      'Analyser les sources et documents existants. Rapporter les faits, références et incertitudes. Ne pas modifier les fichiers.',
    dependencies: [],
  },
  {
    key: 'requirements',
    role: 'Exigences',
    instructions:
      'Analyser les besoins, contraintes et risques. Rapporter les exigences et questions ouvertes. Ne pas modifier les fichiers.',
    dependencies: [],
  },
  {
    key: 'review',
    role: 'Vérification',
    instructions:
      'Vérifier la synthèse du coordinateur et les contributions précédentes. Relever les erreurs, omissions et contrôles utiles. Ne pas modifier les fichiers.',
    dependencies: ['sources', 'requirements'],
  },
];
