package main

func nestedIf(score int, active bool) string {
	label := "none"
	if score > 50 {
		if active {
			label = "hot"
		} else {
			label = "warm"
		}
	}
	return label
}
