import unittest

from app.assistant.rag import CURATED_KNOWLEDGE, build_rag_index, retrieve_pythia_context


class RagTests(unittest.TestCase):
    def test_rag_index_builds_with_recentering_and_whitening(self):
        index = build_rag_index()

        self.assertGreater(len(index.chunks), 5)
        self.assertEqual(index.vectors.shape[0], len(index.chunks))
        self.assertEqual(index.mean.shape[0], 1)
        self.assertEqual(index.components.shape[0], index.scale.shape[0])

    def test_rag_retrieves_forecast_context(self):
        results = retrieve_pythia_context("Can Pythia predict waste tonnage for the next 30 days?", top_k=3)
        joined = " ".join(item["text"].lower() for item in results)

        self.assertIn("14 days or 30 days", joined)
        self.assertIn("first 16 days", joined)
        self.assertIn("predicted_tons", joined)
        self.assertTrue(any("forecast" in item["title"].lower() for item in results))

    def test_overview_describes_the_two_surfaces_and_the_learning_forecast(self):
        overviews = {c["source"]: c["text"] for c in CURATED_KNOWLEDGE if "overview" in c["source"]}
        en = overviews["curated:pythia_overview"]
        idn = overviews["curated:pythia_overview_id"]
        for phrase in ("dispatcher console", "driver app", "7, 14 or 30 days", "self-corrects", "gate slots"):
            self.assertIn(phrase, en)
        for phrase in ("konsol dispatcher", "aplikasi pengemudi", "7, 14 atau 30 hari", "mengoreksi diri"):
            self.assertIn(phrase, idn)
        for text in (en, idn):
            self.assertNotIn("A*", text)
            self.assertNotIn("DLH Jakarta", text)
            self.assertIn("DKI Jakarta", text)

    def test_rag_index_contains_decision_logic_knowledge_docs(self):
        index = build_rag_index()
        sources = {chunk.source for chunk in index.chunks}
        self.assertTrue(
            any(s.startswith("apps/api/knowledge/01_") for s in sources), "decision logic doc not indexed"
        )

    def test_rag_retrieves_tpa_threshold_from_knowledge_doc(self):
        results = retrieve_pythia_context("ambang antrian TPA yellow 45 90 red", top_k=3)
        sources = [item["source"] for item in results]
        self.assertTrue(
            any(s.startswith("apps/api/knowledge/01_") for s in sources), "decision logic doc not in top-3"
        )
        joined = " ".join(item["text"].lower() for item in results)
        self.assertIn("45", joined)
        self.assertIn("90", joined)


if __name__ == "__main__":
    unittest.main()
