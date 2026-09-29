import {z} from 'zod';
// Radar calibration (config/radars.json): per-map pos_x/pos_y/scale from CS2's
// resource/overviews/<map>.txt, an optional pixel size for non-1024 images, and an optional
// custom image under public/radars/ (drop-in) or public/uploads/radars/ (admin upload).
// The admin panel edits this file through PUT /api/radars; a map without a valid entry has no
// radar at all — never a made-up one.
const radarMapSchema=z.object({
 posX:z.number().finite(),
 posY:z.number().finite(),
 scale:z.number().finite().gt(0,'scale must be greater than 0'),
 size:z.number().finite().gt(0).optional(),
 // '' means "use the default radars/<map>.png"; anything else must be a path this host serves.
 image:z.string().trim().max(260).optional().default('')
  .refine(value=>value===''||/^(uploads\/radars\/|radars\/)[\w.\- ]+$/.test(value),
   'image must be a file under radars/ or uploads/radars/'),
}).strip();
export const radarsSchema=z.object({
 overviewSize:z.number().finite().gt(0).optional().default(1024),
 maps:z.record(z.string().trim().min(1).max(64),radarMapSchema).optional().default({}),
}).strip().default({overviewSize:1024,maps:{}});
export type RadarsConfig=z.infer<typeof radarsSchema>;
export type RadarMapConfig=z.infer<typeof radarMapSchema>;
export const emptyRadars=():RadarsConfig=>({overviewSize:1024,maps:{}});
