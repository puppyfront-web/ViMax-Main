from pydantic import BaseModel, Field
from typing import List, Optional, Literal, Tuple
from interfaces.environment import EnvironmentInScene
from interfaces.character import CharacterInScene


class Scene(BaseModel):
    idx: int = Field(
        description="The scene index, starting from 0",
        examples=[0, 1, 2],
    )
    is_last: bool = Field(
        description="Indicates if this is the last scene",
        examples=[False, True],
    )
    environment: EnvironmentInScene = Field(
        description="The detailed scene setting, including location and time",
    )
    characters: List[CharacterInScene] = Field(
        description="A list of characters appearing in the scene, along with their dynamic features like clothing and accessories",
    )
    script: str = Field(
        description="The screenplay script for the scene, including character actions and dialogues. Character names in the script should be enclosed in <>, except for character names within dialogues.",
        examples=[
            "<Jane> paces nervously, clutching a letter. She turns to <John>.\n<Jane>: John, we need to leave tonight.\n<John> shakes his head, stepping toward the window.\n<John>: It's too dangerous.",
            "<Alice> sits quietly, observing the chaos around her. She whispers to <Bob>.\n<Alice>: Bob, do you think they'll find us here?\n<Bob> nods slowly, his expression grim."
        ],
    )

    def __str__(self):
        s = f"Scene {self.idx}:"
        s += f"\nEnvironment: {str(self.environment)}"
        s += f"\nCharacters: {', '.join([str(c) for c in self.characters])}"
        s += f"\nScript: \n{self.script}"
        return s
