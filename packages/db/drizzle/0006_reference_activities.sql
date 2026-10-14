CREATE TABLE "app"."ActivityActions" (
	"UserID" integer NOT NULL,
	"RequestID" varchar(36) NOT NULL,
	"Signature" text NOT NULL,
	"Result" jsonb NOT NULL,
	"CreatedAt" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "ActivityActions_pkey" PRIMARY KEY("UserID","RequestID")
);
--> statement-breakpoint
CREATE TABLE "app"."ActivityStates" (
	"UserID" integer NOT NULL,
	"Activity" varchar(32) NOT NULL,
	"State" jsonb NOT NULL,
	CONSTRAINT "ActivityStates_pkey" PRIMARY KEY("UserID","Activity")
);
--> statement-breakpoint
CREATE TABLE "app"."ActivityWallet" (
	"UserID" integer PRIMARY KEY NOT NULL,
	"Points" integer DEFAULT 0 NOT NULL,
	"Earned" integer DEFAULT 0 NOT NULL,
	"Revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ActivityWallet_nonnegative" CHECK ("app"."ActivityWallet"."Points" >= 0 AND "app"."ActivityWallet"."Earned" >= 0 AND "app"."ActivityWallet"."Revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."ActivityActions" ADD CONSTRAINT "ActivityActions_UserID_ActivityWallet_UserID_fk" FOREIGN KEY ("UserID") REFERENCES "app"."ActivityWallet"("UserID") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ActivityStates" ADD CONSTRAINT "ActivityStates_UserID_ActivityWallet_UserID_fk" FOREIGN KEY ("UserID") REFERENCES "app"."ActivityWallet"("UserID") ON DELETE no action ON UPDATE no action;