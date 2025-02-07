import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './styles.css';

const socket = io('http://localhost:3000');

// Utility function to reorder the players array so the current player is in the center
const reorderPlayers = (players, currentPlayerId) => {
  const currentPlayerIndex = players.findIndex((player) => player.socketId === currentPlayerId);
  if (currentPlayerIndex === -1) return players; // Fallback: return the original array if the current player is not found

  // Calculate the number of players before and after the current player
  const numPlayers = players.length;
  const half = Math.floor(numPlayers / 2);

  const reorderedPlayers = [];
  for (let i = 0; i < numPlayers; i++) {
    const index = (currentPlayerIndex - half + i + numPlayers) % numPlayers;
    reorderedPlayers.push(players[index]);
  }

  return reorderedPlayers;
};

// Dice symbols and emojis
const diceSymbols = ['1', '2', '🏹', '💣', '🍺', '🔫'];

export default function App() {
  const [playerName, setPlayerName] = useState('');
  const [players, setPlayers] = useState([]);
  const [role, setRole] = useState(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [diceResult, setDiceResult] = useState([]); // Current dice result
  const [keptDice, setKeptDice] = useState([]); // Dice the player has chosen to keep
  const [rerollsLeft, setRerollsLeft] = useState(2); // Number of rerolls left
  const [currentTurn, setCurrentTurn] = useState(null);
  const [arrowsInPlay, setArrowsInPlay] = useState(0);
  const [indianAttackActive, setIndianAttackActive] = useState(false);

  useEffect(() => {
    // Listen for updates from the server
    socket.on('playerListUpdate', (updatedPlayers) => {
      console.log('Updated Players:', updatedPlayers);
      setPlayers(updatedPlayers);
    });

    // Handle role assignment
    socket.on('assignRole', (data) => {
      console.log('Assigned Role:', data);
      setRole(data.role); // Update the role state
    });

    // Handle game start
    socket.on('gameStarted', (players) => {
      console.log('Game Started with Players:', players);
      setGameStarted(true);
      setPlayers(players);
    });

    // Handle current turn updates
    socket.on('updateTurn', (currentTurn) => {
      console.log('Current Turn:', currentTurn);
      setCurrentTurn(currentTurn);
    });

    // Handle dice result
    socket.on('diceResult', (result) => {
      console.log('Dice Result:', result);
      setDiceResult(result);
    });

    socket.on('indianAttack', (isActive) => setIndianAttackActive(isActive));
    socket.on('updateArrows', (arrows) => setArrowsInPlay(arrows));

    // Cleanup listeners on unmount
    return () => {
      socket.off('playerListUpdate');
      socket.off('assignRole');
      socket.off('gameStarted');
      socket.off('updateTurn');
      socket.off('diceResult');
      socket.off('indianAttack');
      socket.off('updateArrows');
    };
  }, []);

  const joinGame = () => {
    if (playerName.trim() !== '') {
      socket.emit('joinGame', playerName);
    }
  };

  const startGame = () => {
    socket.emit('startGame');
  };

  const rollDice = () => {
    if (socket.id !== currentTurn) return; // Only the current player can roll

    if (rerollsLeft === 0) {
      alert('No rerolls left!');
      return;
    }

    // Emit the rollDice event with the kept dice
    socket.emit('rollDice', keptDice);
    setRerollsLeft(rerollsLeft - 1); // Decrease rerolls left
  };

  const endTurn = () => {
    // Reset dice and rerolls for the next turn
    setDiceResult([]);
    setKeptDice([]);
    setRerollsLeft(2);

    // Notify the server to move to the next player's turn
    socket.emit('endTurn');
  };

  const toggleKeepDice = (index) => {
    const dice = diceResult[index];
    if (keptDice.includes(dice)) {
      // Remove the dice from keptDice
      setKeptDice(keptDice.filter((d) => d !== dice));
    } else {
      // Add the dice to keptDice
      setKeptDice([...keptDice, dice]);
    }
  };

  return (
    <div className={`app-container ${gameStarted ? 'game-started' : ''}`}>
      {!gameStarted ? (
        <div className="lobby-container">
          <h1 className="title">🎲 Bang! The Dice Game 🎯</h1>
          <input
            type="text"
            placeholder="Enter your name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                joinGame(); // Call the joinGame function when Enter is pressed
              }
            }}
            className="input-field"
          />
          <button onClick={joinGame} className="button join-button">
            Join Game
          </button>

          <h2>Players in Lobby:</h2>
          {players.length > 0 ? (
            <ul>
              {players.map((player, index) => (
                <li key={index}>{player.name}</li>
              ))}
            </ul>
          ) : (
            <p>No players in the lobby yet.</p>
          )}

          {players.length >= 4 && (
            <button onClick={startGame} className="button start-button">
              Start Game
            </button>
          )}
        </div>
      ) : (
        <div className="game-container">
          {/* Centered Player Name */}
          <h2 className="centered-name">{playerName}</h2>

          {/* Player tiles */}
          <div className="player-tiles">
            {reorderPlayers(players, socket.id).map((player, index) => (
              <div
                key={index}
                className={`player-tile ${player.socketId === currentTurn ? 'active' : ''}`}
              >
                <h4>{player.name}</h4>
                <p>Health: {player.health}</p>
                {(player.socketId === socket.id || player.role === 'Sheriff') && (
                  <p>Role: {player.role}</p>
                )}
              </div>
            ))}
          </div>

          {/* Dice Rolling Section */}
          {socket.id === currentTurn && (
            <div className="dice-section">
              <h3>Your Dice</h3>
              <div className="dice-columns">
                <div className="dice-column">
                  <h4>Rolled Dice</h4>
                  {diceResult.map((dice, index) => (
                    <div
                      key={index}
                      className={`dice ${keptDice.includes(dice) ? 'kept' : ''}`}
                      onClick={() => toggleKeepDice(index)}
                    >
                      {dice}
                    </div>
                  ))}
                </div>
                <div className="dice-column">
                  <h4>Kept Dice</h4>
                  {keptDice.map((dice, index) => (
                    <div
                      key={index}
                      className="dice kept"
                      onClick={() => toggleKeepDice(index)}
                    >
                      {dice}
                    </div>
                  ))}
                </div>
              </div>
              <div className="dice-actions">
                <button onClick={rollDice} disabled={rerollsLeft === 0}>
                  Roll ({rerollsLeft} rerolls left)
                </button>
                <button onClick={endTurn}>End Turn</button>
              </div>
            </div>
          )}

          {arrowsInPlay > 0 && (
            <p>Arrows in Play: {arrowsInPlay}</p>
          )}
          {indianAttackActive && (
            <p className="indian-attack">⚠️ Indian Attack Active! ⚠️</p>
          )}
        </div>
      )}
    </div>
  );
}