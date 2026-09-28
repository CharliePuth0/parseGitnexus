package main

func plainIfElse(score int) int {
	bonus := 0
	if score > 50 {
		bonus = 1
	} else {
		bonus = -1
	}
	return bonus
}
