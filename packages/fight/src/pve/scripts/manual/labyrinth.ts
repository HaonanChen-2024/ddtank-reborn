import { registerScript } from "../runtime.js";
import { Labyrinth } from "../generated/Game/Labyrinth.js";

/** GameServerScript/AI/Game/Labyrinth.cs: the generated C# String.Split has no JS runtime method. */
class LabyrinthFixed extends Labyrinth {
  override OnCreated(): void {
    const missionIds = "40001,40002,40003,40004,40005,40006,40007,40008,40009,40010"
      + ",40011,40012,40013,40014,40015,40016,40017,40018,40019,40020"
      + ",40021,40022,40023,40024,40025,40026,40027,40028,40029,40030";
    this.Game.SetupMissions(missionIds);
    this.Game.TotalMissionCount = missionIds.split(",").length;
  }
}

registerScript("GameServerScript.AI.Game.Labyrinth", LabyrinthFixed, "game", "manual");
