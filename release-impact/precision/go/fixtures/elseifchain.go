package main

func elseIfChain(score int) string {
	band := "low"
	if score > 90 {
		band = "high"
	} else if score > 50 {
		band = "mid"
	} else {
		band = "low"
	}
	return band
}
