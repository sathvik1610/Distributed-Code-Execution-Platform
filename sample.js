console.log("Hello from JavaScript in a sandbox!");
setTimeout(() => {
  console.log("Processing array mapping...");
  const fruits = ["apple", "banana", "cherry"];
  const uppercaseFruits = fruits.map(f => f.toUpperCase());
  console.log("Result:", uppercaseFruits);
  console.log("Done!");
}, 500);
