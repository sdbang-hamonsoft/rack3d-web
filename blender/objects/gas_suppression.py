"""Standard SD-GAS, single cylinder. FMS proposed SUPPRESSION, never GAS (detector)."""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from facilities import build
build('gas-suppression', sys.argv[sys.argv.index('--') + 1])
