import {z} from 'zod';
// The operator's live switches (config/operator.json): which scene is on air, which HUD panels are shown,
// the tactical-pause banner and the break countdown. Shared by the host (validation) and the panel
// (types and the scene list), so a scene added here exists everywhere at once.
export const SCENE_IDS=['live','matchup','lineups','veto','bracket','winner','break'] as const;
export type SceneId=typeof SCENE_IDS[number];
// Typed as a full record, so adding a scene id without a title is a compile error.
export const SCENE_TITLES:Record<SceneId,string>={live:'Live game',matchup:'Matchup',lineups:'Lineups',veto:'Map series',bracket:'Tournament tree',winner:'Winner',break:'Break'};
export const controlsSchema=z.object({
 scene:z.enum(SCENE_IDS),
 radar:z.boolean(),
 killfeed:z.boolean(),
 lowerThird:z.boolean(),
 economy:z.boolean(),
 techPause:z.boolean(),
 swapped:z.boolean(),
 // When the break countdown reaches zero, as an absolute host-clock time (epoch ms). null = no timer.
 // An absolute time (not "minutes left") means every output computes the same remaining time no
 // matter when it connected; operator.json files written before this field existed still load.
 breakEndsAt:z.number().int().nonnegative().nullable().optional().default(null),
});
export type Controls=z.infer<typeof controlsSchema>;
export const defaultControls:Controls={scene:'live',radar:true,killfeed:true,lowerThird:true,economy:false,techPause:false,swapped:false,breakEndsAt:null};
