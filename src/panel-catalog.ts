import {Activity,Archive as ArchiveIcon,BarChart3,Flag,Gamepad2,GitMerge,Layers,LayoutDashboard,Monitor,Palette,Radio,Shield,SlidersHorizontal,Swords,Trophy,Users} from 'lucide-react';
import {SCENE_IDS,SCENE_TITLES,type SceneId} from '../server/controls';
// The panel's two catalogues, in one file because the panel is no longer the only place that has to
// name them: /welcome lists the same sections and the same scenes. A public page that keeps its own
// copy of a list like this is a page that will one day advertise a section — or a scene — the product
// does not have, so both read from here. The scene titles come from the host's own SCENE_TITLES and
// the descriptions are typed as a full record over SceneId, so adding a scene without describing it
// is a compile error rather than an empty card.
export interface PanelSection {name:string;icon:any;ownerOnly?:boolean}
export const PANEL_SECTIONS:PanelSection[]=[
 {name:'Overview',icon:LayoutDashboard},
 {name:'Match setup',icon:Swords},
 {name:'Teams & players',icon:Users},
 {name:'Tournament tree',icon:GitMerge},
 {name:'Broadcast scenes',icon:Layers},
 {name:'Overlay Studio',icon:Palette},
 {name:'Map radars',icon:SlidersHorizontal},
 {name:'Replay Studio',icon:Radio},
 {name:'Session archive',icon:ArchiveIcon},
 {name:'Event packages',icon:Layers},
 {name:'Operators & audit',icon:Users,ownerOnly:true},
 {name:'Beta applications',icon:Shield,ownerOnly:true},
 {name:'Operations',icon:Activity,ownerOnly:true},
];
export interface SceneListing {id:SceneId;title:string;desc:string;icon:any}
const SCENE_DETAILS:Record<SceneId,{desc:string;icon:any}>={
 live:{desc:'In-game spectator HUD',icon:Gamepad2},
 matchup:{desc:'Team vs. team introduction',icon:Swords},
 lineups:{desc:'Meet the starting five',icon:Users},
 veto:{desc:'Picks, bans & map scores',icon:Layers},
 bracket:{desc:'The road to the trophy',icon:GitMerge},
 winner:{desc:'The victory moment',icon:Trophy},
 break:{desc:'A moment between the action',icon:Monitor},
 recap:{desc:'Confirmed round result and key eliminations',icon:Flag},
 stats:{desc:'Live K / D / A and MVP comparison',icon:BarChart3},
};
export const SCENE_LIST:SceneListing[]=SCENE_IDS.map(id=>({id,title:SCENE_TITLES[id],...SCENE_DETAILS[id]}));
