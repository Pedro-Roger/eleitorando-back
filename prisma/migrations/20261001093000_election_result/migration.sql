-- CreateTable
CREATE TABLE "election_results" (
    "id" SERIAL NOT NULL,
    "year" INTEGER NOT NULL,
    "office" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "candidateId" INTEGER,
    "candidateName" TEXT NOT NULL,
    "party" TEXT,
    "votes" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'TSE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "election_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "election_results_year_office_turn_city_zone_section_candidateName_key" ON "election_results"("year", "office", "turn", "city", "zone", "section", "candidateName");

-- CreateIndex
CREATE INDEX "election_results_year_city_idx" ON "election_results"("year", "city");

-- CreateIndex
CREATE INDEX "election_results_year_candidateId_idx" ON "election_results"("year", "candidateId");

-- AddForeignKey
ALTER TABLE "election_results" ADD CONSTRAINT "election_results_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
