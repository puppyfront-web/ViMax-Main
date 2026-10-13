import unittest

from vimax_image_worker.vimax_bridge import shot_brief_to_cell


class _ShotBrief:
    def __init__(self):
        self.idx = 2
        self.cam_idx = 1
        self.visual_desc = "Medium shot of <Alice> entering the room."
        self.audio_desc = "[Speaker] Alice (Calm): Hello."


class StoryboardBridgeTest(unittest.TestCase):
    def test_shot_brief_to_cell_maps_vimax_fields(self):
        cell = shot_brief_to_cell(_ShotBrief())

        self.assertEqual(cell["shotBrief"], "Medium shot of <Alice> entering the room.")
        self.assertEqual(cell["cameraIdx"], 1)
        self.assertEqual(cell["shotIdx"], 2)
        self.assertEqual(cell["audioDesc"], "[Speaker] Alice (Calm): Hello.")


if __name__ == "__main__":
    unittest.main()
