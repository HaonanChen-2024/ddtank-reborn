CREATE TABLE "app"."LabyrinthCleanOutPhases" (
	"UserID" integer PRIMARY KEY NOT NULL,
	"Day" varchar(10) NOT NULL,
	"currentFloor" integer NOT NULL,
	"myProgress" integer NOT NULL,
	"remainTime" integer NOT NULL,
	"currentRemainTime" integer NOT NULL,
	"cleanOutAllTime" integer NOT NULL,
	"untilFloor" integer NOT NULL
);
