# Open the input file and read its contents
with open('hold', 'r') as file:
    lines = file.readlines()

# Process each line to find the desired numbers
for line in lines:
    if '_____' in line:
        parts = line.split('_____')
        if len(parts) > 2:  # Ensure there are at least two instances of "_____"
            # Extract the numbers after the second instance
            numbers = parts[2].strip().split(',')
            for number in numbers:
                # Create a text file for each number, appending if it exists
                with open(f"{number}.txt", 'a') as output_file:
                    output_file.write(line.strip() + '\n')
                    output_file.write(lines[lines.index(line) + 1].strip() + '\n')
